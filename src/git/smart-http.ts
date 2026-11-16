// Git smart HTTP: protocol v2 upload-pack (ls-refs and fetch, with shallow), a v0 fallback, the
// v0 receive-pack advertisement and push application. Everything is the same store the REST
// surface reads, so a push is immediately visible in /branches, /commits and /contents.

import type { ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { HttpError, readBody, type RequestContext } from '../http.ts';
import type { Repo } from '../store.ts';
import {
  commitParentsOf,
  commitTreeOf,
  parseTag,
  parseTree,
  type GitObject,
} from './objects.ts';
import { readPack, writePack } from './pack.ts';
import {
  encodePktLine,
  encodePktLines,
  flushPacket,
  parsePktLines,
  parsePktLinesUntilFlush,
  packetText,
  delimPacket,
  type GitPacket,
} from './pktline.ts';

const ZERO_OID = '0'.repeat(40);
const AGENT = 'makefun-forge/1.0';
const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const BODY_LIMIT = 64 * 1024 * 1024;

const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'cache-control': 'no-cache, max-age=0, must-revalidate',
    pragma: 'no-cache',
    expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
  });
  res.end(body);
}

function authorized(req: RequestContext['req']): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const bearer = /^(?:Bearer|token)\s+(.+)$/i.exec(header.trim());
  if (bearer !== null) {
    if (expected === '') return true;
    return bearer[1] === expected;
  }
  const basic = /^Basic\s+(.+)$/i.exec(header.trim());
  if (basic !== null) {
    let decoded = '';
    try {
      decoded = Buffer.from(basic[1] as string, 'base64').toString('utf8');
    } catch {
      return false;
    }
    const colon = decoded.indexOf(':');
    const password = colon < 0 ? decoded : decoded.slice(colon + 1);
    if (expected === '') return true;
    return password === expected;
  }
  return false;
}

function repoOf(ctx: RequestContext, owner: string, name: string): Repo {
  const repo = ctx.store.requireRepo(owner, name);
  if (repo === undefined) throw new HttpError(404, 'Not Found');
  return repo;
}

function refEntries(repo: Repo): { oid: string; name: string }[] {
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const entries: { oid: string; name: string }[] = [];
  if (head !== undefined) entries.push({ oid: head, name: 'HEAD' });
  for (const name of [...repo.refs.keys()].sort()) {
    entries.push({ oid: repo.refs.get(name) as string, name });
  }
  return entries;
}

function peeledTarget(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 8; depth += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type !== 'tag') return current;
    try {
      current = parseTag(object.content).object;
    } catch {
      return null;
    }
  }
  return null;
}

function v0RefAdvertisement(repo: Repo, capabilities: string): Buffer {
  const entries = refEntries(repo);
  const parts: Buffer[] = [];
  if (entries.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${capabilities}\n`));
  } else {
    entries.forEach((entry, index) => {
      const suffix = index === 0 ? `\u0000${capabilities}` : '';
      parts.push(encodePktLine(`${entry.oid} ${entry.name}${suffix}\n`));
      if (entry.name.startsWith('refs/tags/')) {
        const peeled = peeledTarget(repo, entry.oid);
        const object = repo.objects.get(entry.oid);
        if (object !== undefined && object.type === 'tag' && peeled !== null) {
          parts.push(encodePktLine(`${peeled} ${entry.name}^{}\n`));
        }
      }
    });
  }
  parts.push(flushPacket());
  return Buffer.concat(parts);
}

function uploadCapabilities(repo: Repo): string {
  return [
    'multi_ack_detailed',
    'side-band-64k',
    'thin-pack',
    'ofs-delta',
    'shallow',
    'no-progress',
    'include-tag',
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
    'object-format=sha1',
    `agent=${AGENT}`,
  ].join(' ');
}

function receiveCapabilities(repo: Repo): string {
  return [
    'report-status',
    'side-band-64k',
    'delete-refs',
    'ofs-delta',
    'quiet',
    'atomic',
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
    'object-format=sha1',
    `agent=${AGENT}`,
  ].join(' ');
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    encodePktLine('# service=git-upload-pack\n'),
    flushPacket(),
    encodePktLine('version 2\n'),
    encodePktLine(`agent=${AGENT}\n`),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow\n'),
    encodePktLine('server-option\n'),
    encodePktLine('object-format=sha1\n'),
    flushPacket(),
  ]);
}

function infoRefs(ctx: RequestContext, repo: Repo, service: string): void {
  if (service === 'git-upload-pack') {
    const protocol = ctx.req.headers['git-protocol'];
    const wantsV2 = typeof protocol === 'string' && /(?:^|[\s,])version=2(?:$|[\s,])/.test(protocol);
    if (wantsV2) {
      sendBytes(ctx.res, 200, UPLOAD_ADVERTISEMENT, v2Advertisement());
      return;
    }
    const body = Buffer.concat([
      encodePktLine('# service=git-upload-pack\n'),
      flushPacket(),
      v0RefAdvertisement(repo, uploadCapabilities(repo)),
    ]);
    sendBytes(ctx.res, 200, UPLOAD_ADVERTISEMENT, body);
    return;
  }
  if (service === 'git-receive-pack') {
    const body = Buffer.concat([
      encodePktLine('# service=git-receive-pack\n'),
      flushPacket(),
      v0RefAdvertisement(repo, receiveCapabilities(repo)),
    ]);
    sendBytes(ctx.res, 200, RECEIVE_ADVERTISEMENT, body);
    return;
  }
  throw new HttpError(400, 'Unsupported service');
}

function decodeRequestBody(ctx: RequestContext): Promise<Buffer> {
  return readBody(ctx.req, BODY_LIMIT).then((body) => {
    const encoding = String(ctx.req.headers['content-encoding'] ?? '').toLowerCase();
    if (encoding.includes('gzip')) {
      try {
        return gunzipSync(body);
      } catch {
        throw new HttpError(400, 'Bad gzip body');
      }
    }
    return body;
  });
}

function requestLines(packets: readonly GitPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packetText(packet));
  }
  return lines;
}

function lsRefs(repo: Repo, packets: readonly GitPacket[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (!afterDelim || packet.kind !== 'data') continue;
    const line = packetText(packet);
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      const suffix = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      lines.push(encodePktLine(`${headOid} HEAD${suffix}\n`));
    } else if (unborn) {
      const suffix = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      lines.push(encodePktLine(`unborn HEAD${suffix}\n`));
    }
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as string;
    let suffix = '';
    if (peel && name.startsWith('refs/tags/')) {
      const peeled = peeledTarget(repo, oid);
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag' && peeled !== null) suffix += ` peeled:${peeled}`;
    }
    lines.push(encodePktLine(`${oid} ${name}${suffix}\n`));
  }
  lines.push(flushPacket());
  return Buffer.concat(lines);
}

interface FetchRequest {
  readonly wants: string[];
  readonly haves: string[];
  readonly shallow: string[];
  readonly depth: number | null;
}

function parseFetch(lines: readonly string[]): FetchRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const value = Number(line.slice(7).trim());
      if (Number.isSafeInteger(value) && value > 0) depth = value;
    }
  }
  return { wants, haves, shallow, depth };
}

function addTreeClosure(repo: Repo, treeSha: string, out: Set<string>): void {
  const stack = [treeSha];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (out.has(sha)) continue;
    const object = repo.objects.get(sha);
    if (object === undefined) continue;
    if (object.type === 'tree') {
      out.add(sha);
      for (const entry of parseTree(object.content)) {
        if (entry.mode === '160000') continue;
        if (entry.mode === '40000') stack.push(entry.sha);
        else out.add(entry.sha);
      }
    } else if (object.type === 'blob') {
      out.add(sha);
    }
  }
}

function addCommitObjects(repo: Repo, commitSha: string, out: Set<string>): void {
  out.add(commitSha);
  const tree = commitTreeOf(repo.objects, commitSha);
  if (tree !== null) addTreeClosure(repo, tree, out);
}

/** The objects a client already holds: reachable from haves, stopping at its shallow boundary. */
function collectHaveObjects(repo: Repo, haves: readonly string[], shallow: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (out.has(sha)) continue;
    const object = repo.objects.get(sha);
    if (object === undefined) continue;
    out.add(sha);
    if (object.type === 'tag') {
      try {
        stack.push(parseTag(object.content).object);
      } catch {
        // Ignore a corrupt tag in a have set.
      }
    } else if (object.type === 'commit') {
      const tree = commitTreeOf(repo.objects, sha);
      if (tree !== null) addTreeClosure(repo, tree, out);
      if (shallow.has(sha)) continue;
      for (const parent of commitParentsOf(repo.objects, sha)) stack.push(parent);
    } else if (object.type === 'tree') {
      addTreeClosure(repo, sha, out);
    }
  }
  return out;
}

interface WantPlan {
  readonly objects: Set<string>;
  readonly shallow: string[];
  readonly unshallow: string[];
}

/** Everything reachable from the wants, limited by depth and the client's shallow boundaries. */
function collectWantObjects(repo: Repo, request: FetchRequest): WantPlan {
  const objects = new Set<string>();
  const clientShallow = new Set(request.shallow);
  const bestDistance = new Map<string, number>();
  const queue: { sha: string; distance: number }[] = [];
  const boundary = new Set<string>();
  const includedCommits = new Set<string>();

  const addTagChain = (start: string): string | null => {
    let current: string | null = start;
    for (let depth = 0; current !== null && depth < 8; depth += 1) {
      const object = repo.objects.get(current);
      if (object === undefined) return null;
      objects.add(current);
      if (object.type !== 'tag') return current;
      try {
        current = parseTag(object.content).object;
      } catch {
        return null;
      }
    }
    return null;
  };

  for (const want of request.wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      const target = addTagChain(want);
      if (target === null) continue;
      const targetObject = repo.objects.get(target);
      if (targetObject?.type === 'commit') queue.push({ sha: target, distance: 0 });
      else if (targetObject?.type === 'tree') addTreeClosure(repo, target, objects);
      else objects.add(target);
    } else if (object.type === 'commit') {
      queue.push({ sha: want, distance: 0 });
    } else if (object.type === 'tree') {
      addTreeClosure(repo, want, objects);
    } else {
      objects.add(want);
    }
  }

  while (queue.length > 0) {
    const item = queue.shift() as { sha: string; distance: number };
    const previous = bestDistance.get(item.sha);
    if (previous !== undefined && previous <= item.distance) continue;
    bestDistance.set(item.sha, item.distance);
    includedCommits.add(item.sha);
    addCommitObjects(repo, item.sha, objects);
    const parents = commitParentsOf(repo.objects, item.sha);
    if (request.depth !== null) {
      if (item.distance + 1 < request.depth) {
        for (const parent of parents) queue.push({ sha: parent, distance: item.distance + 1 });
      } else if (parents.length > 0) {
        boundary.add(item.sha);
      }
    } else if (!clientShallow.has(item.sha)) {
      for (const parent of parents) queue.push({ sha: parent, distance: item.distance + 1 });
    }
  }

  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const sha of boundary) if (!clientShallow.has(sha)) shallow.push(sha);
  if (request.depth !== null) {
    for (const sha of clientShallow) {
      const distance = bestDistance.get(sha);
      if (distance !== undefined && distance < request.depth - 1 && !boundary.has(sha)) unshallow.push(sha);
    }
  }
  return { objects, shallow, unshallow };
}

function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const chunkSize = 60_000;
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + chunkSize));
    const payload = Buffer.allocUnsafe(chunk.length + 1);
    payload[0] = 1;
    chunk.copy(payload, 1);
    parts.push(encodePktLine(payload));
  }
  if (pack.length === 0) parts.push(encodePktLine(Buffer.from([1])));
  return parts;
}

function planPack(repo: Repo, request: FetchRequest): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const plan = collectWantObjects(repo, request);
  const haves = collectHaveObjects(repo, request.haves, new Set(request.shallow));
  const send: GitObject[] = [];
  for (const sha of plan.objects) {
    if (haves.has(sha)) continue;
    const object = repo.objects.get(sha);
    if (object !== undefined) send.push(object);
  }
  return { pack: writePack(send), shallow: plan.shallow, unshallow: plan.unshallow };
}

function v2Fetch(repo: Repo, packets: readonly GitPacket[]): Buffer {
  const request = parseFetch(requestLines(packets));
  const { pack, shallow, unshallow } = planPack(repo, request);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  if (request.haves.length === 0) {
    parts.push(encodePktLine('NAK\n'));
  } else {
    for (const have of request.haves) if (repo.objects.has(have)) parts.push(encodePktLine(`ACK ${have}\n`));
    parts.push(encodePktLine('ready\n'));
  }
  parts.push(delimPacket());
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const sha of shallow) parts.push(encodePktLine(`shallow ${sha}\n`));
    for (const sha of unshallow) parts.push(encodePktLine(`unshallow ${sha}\n`));
    parts.push(delimPacket());
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(flushPacket());
  return Buffer.concat(parts);
}

function parseV0Fetch(packets: readonly GitPacket[]): FetchRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let inNegotiation = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      inNegotiation = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packetText(packet);
    if (!inNegotiation) {
      if (line.startsWith('want ')) {
        const oid = (line.slice(5).trim().split(/\s+/)[0] ?? '').trim();
        if (oid !== '') wants.push(oid);
      } else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const value = Number(line.slice(7).trim());
        if (Number.isSafeInteger(value) && value > 0) depth = value;
      }
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    }
  }
  return { wants, haves, shallow, depth };
}

function v0Fetch(repo: Repo, packets: readonly GitPacket[]): Buffer {
  const request = parseV0Fetch(packets);
  const { pack, shallow, unshallow } = planPack(repo, request);
  const parts: Buffer[] = [];
  for (const sha of shallow) parts.push(encodePktLine(`shallow ${sha}\n`));
  for (const sha of unshallow) parts.push(encodePktLine(`unshallow ${sha}\n`));
  parts.push(encodePktLine('NAK\n'));
  parts.push(...sidebandPack(pack));
  parts.push(flushPacket());
  return Buffer.concat(parts);
}

function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    for (const parent of commitParentsOf(repo.objects, sha)) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) stack.push(parent);
    }
  }
  return false;
}

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function parsePushCommands(packets: readonly GitPacket[]): { commands: PushCommand[]; capabilities: Set<string> } {
  const commands: PushCommand[] = [];
  const capabilities = new Set<string>();
  let first = true;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8');
    if (first) {
      const nul = text.indexOf('\u0000');
      if (nul >= 0) {
        for (const capability of text.slice(nul + 1).split(' ')) if (capability !== '') capabilities.add(capability);
        text = text.slice(0, nul);
      }
      first = false;
    }
    const line = text.replace(/\n$/, '');
    if (line === '') continue;
    const parts = line.split(' ');
    if (parts.length < 3) throw new HttpError(400, 'Bad push command');
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
  }
  return { commands, capabilities };
}

function receivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, rest } = parsePktLinesUntilFlush(body);
  const { commands, capabilities } = parsePushCommands(packets);
  let unpackError: string | null = null;
  if (rest.length > 0) {
    try {
      const parsed = readPack(rest, repo.objects);
      for (const [sha, object] of parsed.objects) {
        if (!repo.objects.has(sha)) repo.objects.set(sha, object);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  } else if (commands.some((command) => command.newOid !== ZERO_OID)) {
    unpackError = 'missing packfile';
  }

  const report: string[] = [unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`];
  const now = Date.now();
  for (const command of commands) {
    if (unpackError !== null) {
      report.push(`ng ${command.ref} unpacker error\n`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined) {
        report.push(`ng ${command.ref} not found\n`);
      } else if (command.oldOid !== ZERO_OID && current !== command.oldOid) {
        report.push(`ng ${command.ref} stale info\n`);
      } else {
        repo.refs.delete(command.ref);
        report.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      report.push(`ng ${command.ref} missing necessary objects\n`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        report.push(`ng ${command.ref} already exists\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      report.push(`ok ${command.ref}\n`);
      continue;
    }
    if (current === undefined || current !== command.oldOid) {
      report.push(`ng ${command.ref} stale info\n`);
      continue;
    }
    if (!isAncestor(repo, command.oldOid, command.newOid)) {
      report.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    report.push(`ok ${command.ref}\n`);
  }
  repo.updatedAt = now;
  repo.pushedAt = now;

  const inner = encodePktLines([...report, 'flush']);
  if (!capabilities.has('side-band-64k')) return inner;
  const parts: Buffer[] = [];
  const chunkSize = 60_000;
  for (let offset = 0; offset < inner.length; offset += chunkSize) {
    const chunk = inner.subarray(offset, Math.min(inner.length, offset + chunkSize));
    const framed = Buffer.allocUnsafe(chunk.length + 1);
    framed[0] = 1;
    chunk.copy(framed, 1);
    parts.push(encodePktLine(framed));
  }
  parts.push(flushPacket());
  return Buffer.concat(parts);
}

function uploadPack(repo: Repo, body: Buffer): Buffer {
  const { packets } = parsePktLines(body);
  const lines = requestLines(packets);
  const command = lines.find((line) => line.startsWith('command='));
  if (command === 'command=ls-refs') return lsRefs(repo, packets);
  if (command === 'command=fetch') return v2Fetch(repo, packets);
  return v0Fetch(repo, packets);
}

/** Handle one /{owner}/{repo}.git/... request; false when the path is not a git route. */
export async function handleGit(ctx: RequestContext): Promise<boolean> {
  const match = GIT_PATH.exec(ctx.url.pathname);
  if (match === null) return false;
  let owner: string;
  let name: string;
  try {
    owner = decodeURIComponent(match[1] as string);
    name = decodeURIComponent(match[2] as string);
  } catch {
    throw new HttpError(404, 'Not Found');
  }
  if (!authorized(ctx.req)) throw new HttpError(401, 'Bad credentials');
  const repo = repoOf(ctx, owner, name);
  const endpoint = match[3] as string;
  const method = ctx.req.method ?? 'GET';

  if (endpoint === 'info/refs') {
    if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
    const service = ctx.url.searchParams.get('service') ?? '';
    infoRefs(ctx, repo, service);
    return true;
  }

  if (method !== 'POST') throw new HttpError(405, 'Method Not Allowed');
  const body = await decodeRequestBody(ctx);
  if (endpoint === 'git-upload-pack') {
    let result: Buffer;
    try {
      result = uploadPack(repo, body);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, 'Malformed upload-pack request');
    }
    sendBytes(ctx.res, 200, UPLOAD_RESULT, result);
    return true;
  }
  let result: Buffer;
  try {
    result = receivePack(repo, body);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'Malformed receive-pack request');
  }
  sendBytes(ctx.res, 200, RECEIVE_RESULT, result);
  return true;
}
