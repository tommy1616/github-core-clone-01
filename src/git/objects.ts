// Git's object model on node:crypto only: the loose-object hash, tree and commit encoding and
// decoding, and the tree walkers the REST contents and pull-request code build on. A later step
// puts packfiles and smart HTTP on top of these same raw object bytes.

import { createHash } from 'node:crypto';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly content: Buffer;
}

export type ObjectDatabase = Map<string, GitObject>;

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly sha: string;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export interface CommitIdentity {
  readonly name: string;
  readonly email: string;
}

export interface CreateCommitInput {
  readonly tree: string;
  readonly parents?: readonly string[];
  readonly message: string;
  readonly author: CommitIdentity;
  readonly committer?: CommitIdentity;
  readonly timestamp?: number;
  readonly timezone?: string;
}

const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** `<type> <size>\0` plus the content: the bytes git hashes for an object id. */
export function encodeObject(type: GitObjectType, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${content.length}\u0000`, 'utf8'), content]);
}

export function hashObject(type: GitObjectType, content: Buffer): string {
  return createHash('sha1').update(encodeObject(type, content)).digest('hex');
}

/** Store one object and answer its id; an object already present is not rewritten. */
export function putObject(objects: ObjectDatabase, type: GitObjectType, content: Buffer): string {
  const sha = hashObject(type, content);
  if (!objects.has(sha)) objects.set(sha, { type, content });
  return sha;
}

export function getObject(objects: ObjectDatabase, sha: string): GitObject | undefined {
  return objects.get(sha);
}

/** Parse a loose-object buffer (`<type> <size>\0<content>`) back into type and content. */
export function decodeObject(buffer: Buffer): GitObject {
  const nul = buffer.indexOf(0);
  if (nul < 0) throw new Error('object has no header terminator');
  const header = buffer.subarray(0, nul).toString('utf8');
  const space = header.indexOf(' ');
  if (space <= 0) throw new Error('object header is malformed');
  const type = header.slice(0, space);
  const size = Number(header.slice(space + 1));
  if (type !== 'blob' && type !== 'tree' && type !== 'commit' && type !== 'tag') {
    throw new Error(`unknown object type ${JSON.stringify(type)}`);
  }
  const content = buffer.subarray(nul + 1);
  if (!Number.isSafeInteger(size) || content.length !== size) throw new Error('object size does not match its header');
  return { type, content };
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Serialise a tree the way git does: entries sorted with directories compared as `name/`. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of [...entries].sort(compareTreeNames)) {
    if (!isObjectId(entry.sha)) throw new Error(`tree entry ${JSON.stringify(entry.name)} has a bad object id`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(content: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = content.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > content.length) throw new Error('tree entry is truncated');
    const mode = content.subarray(offset, space).toString('ascii');
    const name = content.subarray(space + 1, nul).toString('utf8');
    const sha = content.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

export function buildCommit(input: CreateCommitInput): Buffer {
  if (!isObjectId(input.tree)) throw new Error('commit needs a valid tree id');
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const timezone = input.timezone ?? '+0000';
  const author = `${input.author.name} <${input.author.email}> ${timestamp} ${timezone}`;
  const committer = input.committer ?? input.author;
  const committerLine = `${committer.name} <${committer.email}> ${timestamp} ${timezone}`;
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents ?? []) {
    if (!isObjectId(parent)) throw new Error('commit needs valid parent ids');
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${author}`, `committer ${committerLine}`, '');
  return Buffer.from(`${lines.join('\n')}\n${input.message}`, 'utf8');
}

export function parseCommit(content: Buffer): CommitView {
  const blank = content.indexOf('\n\n');
  const headerEnd = blank < 0 ? content.length : blank;
  const message = blank < 0 ? '' : content.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of content.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree');
  return { tree, parents, author, committer, message };
}

export function buildTag(input: {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly message: string;
  readonly tagger?: CommitIdentity;
  readonly timestamp?: number;
  readonly timezone?: string;
}): Buffer {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const timezone = input.timezone ?? '+0000';
  const tagger = input.tagger ?? { name: 'Conformance', email: 'conformance@make.fun' };
  return Buffer.from(
    `object ${input.object}\ntype ${input.type}\ntag ${input.tag}\ntagger ${tagger.name} <${tagger.email}> ${timestamp} ${timezone}\n\n${input.message}`,
    'utf8',
  );
}

export function parseTag(content: Buffer): { object: string; type: GitObjectType; tag: string; tagger: string; message: string } {
  const blank = content.indexOf('\n\n');
  const headerEnd = blank < 0 ? content.length : blank;
  const headers = new Map<string, string>();
  for (const line of content.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = (headers.get('type') ?? 'blob') as GitObjectType;
  return {
    object,
    type,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : content.subarray(blank + 2).toString('utf8'),
  };
}

/** Build blobs and trees from a path -> bytes map; answer the root tree id. */
export function buildTreeFromContents(objects: ObjectDatabase, files: ReadonlyMap<string, Buffer>): string {
  interface Node {
    files: Map<string, Buffer>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, data] of files) {
    const segments = path.split('/').filter((segment) => segment !== '');
    if (segments.length === 0) continue;
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index] as string;
      let child = node.dirs.get(name);
      if (child === undefined) {
        child = make();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, data);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, data] of node.files) {
      entries.push({ mode: '100644', name, sha: putObject(objects, 'blob', data) });
    }
    for (const [name, child] of node.dirs) {
      entries.push({ mode: '40000', name, sha: build(child) });
    }
    return putObject(objects, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Every file reachable from a tree, as path -> bytes (gitlinks and tags are not followed). */
export function readTreeContents(objects: ObjectDatabase, treeSha: string, prefix = ''): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const tree = objects.get(treeSha);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.content)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [childPath, data] of readTreeContents(objects, entry.sha, path)) out.set(childPath, data);
      continue;
    }
    if (entry.mode === '160000') continue;
    const blob = objects.get(entry.sha);
    if (blob !== undefined && blob.type === 'blob') out.set(path, blob.content);
  }
  return out;
}

/** Every blob reachable from a tree, as path -> object id. */
export function readTreeIndex(objects: ObjectDatabase, treeSha: string, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  const tree = objects.get(treeSha);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.content)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [childPath, sha] of readTreeIndex(objects, entry.sha, path)) out.set(childPath, sha);
    } else if (entry.mode !== '160000') {
      out.set(path, entry.sha);
    }
  }
  return out;
}

/** A commit's tree id, or null when the object is absent or not a commit. */
export function commitTreeOf(objects: ObjectDatabase, commitSha: string): string | null {
  const object = objects.get(commitSha);
  if (object === undefined || object.type !== 'commit') return null;
  try {
    return parseCommit(object.content).tree;
  } catch {
    return null;
  }
}

export function commitParentsOf(objects: ObjectDatabase, commitSha: string): string[] {
  const object = objects.get(commitSha);
  if (object === undefined || object.type !== 'commit') return [];
  try {
    return parseCommit(object.content).parents;
  } catch {
    return [];
  }
}
