// Git's pkt-line framing: 4 hex length bytes, then the payload. Flush (0000), delimiter (0001)
// and response-end (0002) are the control packets. The decoder is incremental so a request body
// can be fed in chunks and stopped exactly where a command section ends (a receive-pack body
// carries a binary packfile after its flush).

export const PKT_LINE_MAX = 65520;
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

export type GitPacket =
  | { readonly kind: 'data'; readonly payload: Buffer; readonly raw: Buffer }
  | { readonly kind: 'flush'; readonly raw: Buffer }
  | { readonly kind: 'delim'; readonly raw: Buffer }
  | { readonly kind: 'response-end'; readonly raw: Buffer };

export type PacketInput = string | Uint8Array | 'flush' | 'delim' | 'response-end';

function asBuffer(value: string | Uint8Array): Buffer {
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
}

export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = asBuffer(payload);
  if (data.length > PKT_LINE_MAX_PAYLOAD) throw new Error(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte limit`);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function flushPacket(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function delimPacket(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function responseEndPacket(): Buffer {
  return Buffer.from('0002', 'ascii');
}

export function encodePktLines(items: readonly PacketInput[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(flushPacket());
    else if (item === 'delim') parts.push(delimPacket());
    else if (item === 'response-end') parts.push(responseEndPacket());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** An incremental pkt-line decoder. `bytesConsumed` counts the bytes of complete packets read. */
export class PktLineDecoder {
  private pending: Buffer = Buffer.alloc(0);
  private offset = 0;
  private consumed = 0;

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    const buffer = Buffer.from(chunk);
    this.pending = this.offset === 0 ? buffer : Buffer.concat([this.pending.subarray(this.offset), buffer]);
    this.offset = 0;
  }

  get bytesConsumed(): number {
    return this.consumed;
  }

  next(): GitPacket | null {
    if (this.pending.length - this.offset < 4) return null;
    const header = this.pending.subarray(this.offset, this.offset + 4).toString('ascii');
    if (!HEX4.test(header)) throw new Error(`pkt-line length ${JSON.stringify(header)} is not four hex digits`);
    const length = parseInt(header, 16);
    if (length === 0 || length === 1 || length === 2) {
      const raw = Buffer.from(header, 'ascii');
      this.offset += 4;
      this.consumed += 4;
      if (length === 0) return { kind: 'flush', raw };
      if (length === 1) return { kind: 'delim', raw };
      return { kind: 'response-end', raw };
    }
    if (length < 4) throw new Error(`pkt-line length ${length} is below the 4-byte header`);
    if (this.pending.length - this.offset < length) return null;
    const payload = this.pending.subarray(this.offset + 4, this.offset + length);
    const raw = this.pending.subarray(this.offset, this.offset + length);
    const packet: GitPacket = { kind: 'data', payload: Buffer.from(payload), raw: Buffer.from(raw) };
    this.offset += length;
    this.consumed += length;
    return packet;
  }

  finish(): void {
    if (this.pending.length !== this.offset) throw new Error(`pkt-line stream has ${this.pending.length - this.offset} trailing byte(s)`);
  }
}

/** Decode every complete pkt-line in `buffer`; `rest` is what follows the last packet. */
export function parsePktLines(buffer: Buffer): { packets: GitPacket[]; rest: Buffer } {
  const decoder = new PktLineDecoder();
  decoder.push(buffer);
  const packets: GitPacket[] = [];
  for (let packet = decoder.next(); packet !== null; packet = decoder.next()) packets.push(packet);
  return { packets, rest: buffer.subarray(decoder.bytesConsumed) };
}

/** Decode up to and including the first flush; the remaining bytes are a packfile. */
export function parsePktLinesUntilFlush(buffer: Buffer): { packets: GitPacket[]; rest: Buffer } {
  const decoder = new PktLineDecoder();
  decoder.push(buffer);
  const packets: GitPacket[] = [];
  for (;;) {
    const packet = decoder.next();
    if (packet === null) break;
    packets.push(packet);
    if (packet.kind === 'flush') break;
  }
  return { packets, rest: buffer.subarray(decoder.bytesConsumed) };
}

/** The text of one data packet, without its trailing newline. */
export function packetText(packet: GitPacket): string {
  return packet.kind === 'data' ? packet.payload.toString('utf8').replace(/\n$/, '') : '';
}
