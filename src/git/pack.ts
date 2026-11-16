// Git packfile reading and writing on node:zlib. The writer emits plain objects (no deltas) and
// caches each object's deflated bytes; the reader handles all four object types plus OFS_DELTA and
// REF_DELTA, verifies the trailer checksum and returns the resolved objects keyed by their SHA-1.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  hashObject,
  type GitObject,
  type GitObjectType,
  type ObjectDatabase,
} from './objects.ts';

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

const DEFLATED_CACHE = new WeakMap<GitObject, Buffer>();

function deflated(object: GitObject): Buffer {
  const cached = DEFLATED_CACHE.get(object);
  if (cached !== undefined) return cached;
  const bytes = deflateSync(object.content);
  DEFLATED_CACHE.set(object, bytes);
  return bytes;
}

function writeObjectHeader(type: GitObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (TYPE_CODE[type] << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A version-2 packfile of plain objects, with its SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writeObjectHeader(object.type, object.content.length));
    parts.push(deflated(object));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

interface RawEntry {
  readonly offset: number;
  readonly typeCode: number;
  readonly size: number;
  readonly data: Buffer;
  readonly baseOffset?: number;
  readonly baseOid?: string;
}

function readTypeAndSize(buffer: Buffer, start: number): { typeCode: number; size: number; next: number } {
  if (start >= buffer.length) throw new Error('pack entry has no header');
  let byte = buffer[start] as number;
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { typeCode, size, next: offset };
}

function readOfsBase(buffer: Buffer, start: number): { distance: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset] as number;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { distance: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  try {
    const result = inflateSync(view, { info: true }) as unknown;
    if (result !== null && typeof result === 'object' && !Buffer.isBuffer(result)) {
      const info = result as { buffer?: Buffer; engine?: { bytesWritten?: number } };
      if (Buffer.isBuffer(info.buffer) && typeof info.engine?.bytesWritten === 'number' && info.engine.bytesWritten > 0) {
        return { data: info.buffer, next: offset + info.engine.bytesWritten };
      }
    }
  } catch {
    // Fall through to the prefix search below.
  }
  // Older zlib convenience methods return only the buffer. The shortest prefix that inflates is
  // exactly the compressed stream's end, so find it with a binary search.
  let low = 1;
  let high = view.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    try {
      inflateSync(view.subarray(0, middle));
      high = middle;
    } catch {
      low = middle + 1;
    }
  }
  if (low > view.length) throw new Error(`zlib stream at offset ${offset} did not inflate`);
  return { data: inflateSync(view.subarray(0, low)), next: offset + low };
}

function readDeltaSize(delta: Buffer, start: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let offset = start;
  for (;;) {
    if (offset >= delta.length) throw new Error('delta size varint is truncated');
    const byte = delta[offset] as number;
    offset += 1;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(byte & 0x80)) break;
    if (shift > 63) throw new Error('delta size varint is too long');
  }
  return { value, next: offset };
}

/** Apply a git delta (copy/insert instructions) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const source = readDeltaSize(delta, 0);
  const target = readDeltaSize(delta, source.next);
  if (source.value !== base.length) throw new Error(`delta expects a ${source.value}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(target.value);
  let offset = target.next;
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is outside the base');
      if (written + copySize > target.value) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const length = op & 0x7f;
      if (offset + length > delta.length) throw new Error('delta insert is truncated');
      if (written + length > target.value) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + length);
      offset += length;
      written += length;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== target.value) throw new Error(`delta produced ${written} of ${target.value} bytes`);
  return out;
}

export interface PackReadResult {
  readonly objects: Map<string, GitObject>;
  readonly declaredCount: number;
  readonly deltaCount: number;
  readonly checksumOk: boolean;
}

/** Parse a packfile, resolving deltas against earlier entries, this pack or the supplied database. */
export function readPack(pack: Buffer, existing?: ObjectDatabase, target?: ObjectDatabase): PackReadResult {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const expected = pack.subarray(trailerStart);
  const actual = createHash('sha1').update(pack.subarray(0, trailerStart)).digest();
  const checksumOk = actual.equals(expected);
  if (!checksumOk) throw new Error('pack trailer checksum does not match its bytes');
  const body = pack.subarray(0, trailerStart);

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readTypeAndSize(body, offset);
    offset = header.next;
    if (header.typeCode !== 6 && header.typeCode !== 7 && CODE_TYPE[header.typeCode] === undefined) {
      throw new Error(`pack entry ${index} has unknown type code ${header.typeCode}`);
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (header.typeCode === 6) {
      const base = readOfsBase(body, offset);
      offset = base.next;
      if (base.distance <= 0 || base.distance > entryOffset) throw new Error('ofs-delta base offset is invalid');
      baseOffset = entryOffset - base.distance;
    } else if (header.typeCode === 7) {
      if (offset + 20 > body.length) throw new Error('ref-delta base id is truncated');
      baseOid = body.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(body, offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    offset = inflated.next;
    const entry: RawEntry = { offset: entryOffset, typeCode: header.typeCode, size: header.size, data: inflated.data, baseOffset, baseOid };
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== body.length) throw new Error(`pack has ${body.length - offset} stray bytes before its trailer`);

  interface Resolved {
    type: GitObjectType;
    data: Buffer;
    oid: string;
  }
  const objects = new Map<string, GitObject>();
  let pending = raw.filter((entry) => entry.typeCode === 6 || entry.typeCode === 7);
  const deltaCount = pending.length;

  if (pending.length === 0) {
    for (const entry of raw) {
      const type = CODE_TYPE[entry.typeCode] as GitObjectType;
      const oid = hashObject(type, entry.data);
      const object: GitObject = { type, content: entry.data };
      objects.set(oid, object);
      if (target !== undefined && !target.has(oid)) target.set(oid, object);
    }
    return { objects, declaredCount, deltaCount: 0, checksumOk };
  }

  const resolvedByOffset = new Map<number, Resolved>();
  const resolvedByOid = new Map<string, Resolved>();

  const record = (entry: RawEntry, type: GitObjectType, data: Buffer): Resolved => {
    const oid = hashObject(type, data);
    const resolved: Resolved = { type, data, oid };
    resolvedByOffset.set(entry.offset, resolved);
    if (!resolvedByOid.has(oid)) resolvedByOid.set(oid, resolved);
    if (!objects.has(oid)) {
      const object: GitObject = { type, content: data };
      objects.set(oid, object);
      if (target !== undefined && !target.has(oid)) target.set(oid, object);
    }
    return resolved;
  };

  for (const entry of raw) {
    if (entry.typeCode === 6 || entry.typeCode === 7) continue;
    record(entry, CODE_TYPE[entry.typeCode] as GitObjectType, entry.data);
  }
  for (let pass = 0; pending.length > 0 && pass <= raw.length; pass += 1) {
    const remaining: RawEntry[] = [];
    let progressed = false;
    for (const entry of pending) {
      let base: Resolved | undefined;
      if (entry.typeCode === 6) {
        base = resolvedByOffset.get(entry.baseOffset as number);
      } else {
        base = resolvedByOid.get(entry.baseOid as string);
        if (base === undefined) {
          const external = existing?.get(entry.baseOid as string);
          if (external !== undefined) {
            base = { type: external.type, data: external.content, oid: entry.baseOid as string };
          }
        }
      }
      if (base === undefined) {
        remaining.push(entry);
        continue;
      }
      record(entry, base.type, applyDelta(base.data, entry.data));
      progressed = true;
    }
    pending = remaining;
    if (!progressed) break;
  }
  if (pending.length > 0) throw new Error(`${pending.length} delta object(s) could not resolve their base`);

  return { objects, declaredCount, deltaCount, checksumOk };
}
