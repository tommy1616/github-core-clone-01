// The contents API: read a file or list a directory at a ref, create or update a file with a
// commit, delete one. Every write goes through real git blobs, trees and commits.

import {
  HttpError,
  readJsonBody,
  sendJson,
  stringField,
  type RequestContext,
} from '../http.ts';
import { iso, type Repo, type User } from '../store.ts';
import {
  buildCommit,
  buildTreeFromContents,
  commitTreeOf,
  hashObject,
  parseTree,
  putObject,
  type CommitIdentity,
} from '../git/objects.ts';
import { encodePath, repoApiUrl } from './serialize.ts';
import { repoOr404 } from './repos.ts';
import type { RouteHandler } from './index.ts';

interface Identity {
  readonly identity: CommitIdentity;
  readonly timestamp: number;
}

function identityOf(value: unknown, fallback: User): Identity {
  if (typeof value !== 'object' || value === null) {
    return { identity: { name: fallback.name, email: fallback.email }, timestamp: Math.floor(Date.now() / 1000) };
  }
  const record = value as Record<string, unknown>;
  const name = stringField(record.name) ?? fallback.name;
  const email = stringField(record.email) ?? fallback.email;
  let timestamp = Math.floor(Date.now() / 1000);
  const date = stringField(record.date);
  if (date !== undefined) {
    const parsed = Date.parse(date);
    if (Number.isFinite(parsed)) timestamp = Math.floor(parsed / 1000);
  }
  return { identity: { name, email }, timestamp };
}

function commitPayload(ctx: RequestContext, repo: Repo, sha: string): Record<string, unknown> {
  const object = repo.objects.get(sha);
  const text = object?.type === 'commit' ? object.content.toString('utf8') : '';
  const blank = text.indexOf('\n\n');
  const headers = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of headers.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
  }
  const parse = (line: string): Record<string, unknown> => {
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (match === null) return { name: repo.owner.name, email: repo.owner.email, date: iso(0) };
    return { name: match[1] as string, email: match[2] as string, date: iso(Number(match[3]) * 1000) };
  };
  return {
    sha,
    node_id: Buffer.from(`010:Commit${sha}`, 'utf8').toString('base64'),
    url: `${repoApiUrl(ctx.origin, repo)}/git/commits/${sha}`,
    html_url: `${ctx.origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/commit/${sha}`,
    author: parse(author),
    committer: parse(committer),
    tree: { sha: tree, url: `${repoApiUrl(ctx.origin, repo)}/git/trees/${tree}` },
    message,
    parents: parents.map((parent) => ({ sha: parent, url: `${repoApiUrl(ctx.origin, repo)}/git/commits/${parent}` })),
    verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
  };
}

function contentEntry(ctx: RequestContext, repo: Repo, ref: string, path: string, sha: string, size: number): Record<string, unknown> {
  return {
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    sha,
    size,
    url: `${repoApiUrl(ctx.origin, repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
    html_url: `${ctx.origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/blob/${encodeURIComponent(ref)}/${encodePath(path)}`,
    git_url: `${repoApiUrl(ctx.origin, repo)}/git/blobs/${sha}`,
    download_url: `${ctx.origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/raw/${encodeURIComponent(ref)}/${encodePath(path)}`,
    type: 'file',
    content: Buffer.from('').toString('base64'),
    encoding: 'base64',
  };
}

function fileReply(ctx: RequestContext, repo: Repo, ref: string, path: string, sha: string, content: Buffer): Record<string, unknown> {
  return {
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    sha,
    size: content.length,
    url: `${repoApiUrl(ctx.origin, repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
    html_url: `${ctx.origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/blob/${encodeURIComponent(ref)}/${encodePath(path)}`,
    git_url: `${repoApiUrl(ctx.origin, repo)}/git/blobs/${sha}`,
    download_url: `${ctx.origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/raw/${encodeURIComponent(ref)}/${encodePath(path)}`,
    type: 'file',
    content: content.toString('base64'),
    encoding: 'base64',
    _links: {
      self: `${repoApiUrl(ctx.origin, repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
      git: `${repoApiUrl(ctx.origin, repo)}/git/blobs/${sha}`,
      html: `${ctx.origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/blob/${encodeURIComponent(ref)}/${encodePath(path)}`,
    },
  };
}

function directoryReply(ctx: RequestContext, repo: Repo, ref: string, treeSha: string, prefix: string): Record<string, unknown>[] {
  const tree = repo.objects.get(treeSha);
  if (tree === undefined || tree.type !== 'tree') throw new HttpError(404, 'Not Found');
  const entries = parseTree(tree.content).map((entry) => {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const child = repo.objects.get(entry.sha);
    if (entry.mode === '40000') {
      return {
        name: entry.name,
        path,
        sha: entry.sha,
        size: 0,
        url: `${repoApiUrl(ctx.origin, repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
        html_url: `${ctx.origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/tree/${encodeURIComponent(ref)}/${encodePath(path)}`,
        git_url: `${repoApiUrl(ctx.origin, repo)}/git/trees/${entry.sha}`,
        download_url: null,
        type: 'dir',
        _links: {
          self: `${repoApiUrl(ctx.origin, repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
          git: `${repoApiUrl(ctx.origin, repo)}/git/trees/${entry.sha}`,
          html: `${ctx.origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/tree/${encodeURIComponent(ref)}/${encodePath(path)}`,
        },
      };
    }
    const size = child !== undefined && child.type === 'blob' ? child.content.length : 0;
    return contentEntry(ctx, repo, ref, path, entry.sha, size);
  });
  entries.sort((a, b) => ((a.path as string) < (b.path as string) ? -1 : (a.path as string) > (b.path as string) ? 1 : 0));
  return entries;
}

function locate(repo: Repo, treeSha: string, path: string): { kind: 'file' | 'dir'; sha: string; tree?: string } | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  let tree = treeSha;
  let prefix = '';
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.objects.get(tree);
    if (object === undefined || object.type !== 'tree') return null;
    const name = segments[index] as string;
    const entry = parseTree(object.content).find((candidate) => candidate.name === name);
    if (entry === undefined) return null;
    prefix = prefix === '' ? name : `${prefix}/${name}`;
    if (index === segments.length - 1) {
      if (entry.mode === '40000') return { kind: 'dir', sha: entry.sha, tree: entry.sha };
      return { kind: 'file', sha: entry.sha };
    }
    if (entry.mode !== '40000') return null;
    tree = entry.sha;
  }
  return { kind: 'dir', sha: tree, tree };
}

function readContents(ctx: RequestContext, repo: Repo, path: string): void {
  const ref = ctx.url.searchParams.get('ref') ?? repo.defaultBranch;
  const commit = ctx.store.resolveCommit(repo, ref);
  if (commit === null) throw new HttpError(404, 'Not Found');
  const tree = commitTreeOf(repo.objects, commit);
  if (tree === null) throw new HttpError(404, 'Not Found');
  const found = locate(repo, tree, path);
  if (found === null) throw new HttpError(404, 'Not Found');
  if (found.kind === 'dir') {
    sendJson(ctx.res, 200, directoryReply(ctx, repo, ref, found.tree as string, path));
    return;
  }
  const blob = repo.objects.get(found.sha);
  if (blob === undefined || blob.type !== 'blob') throw new HttpError(404, 'Not Found');
  sendJson(ctx.res, 200, fileReply(ctx, repo, ref, path, found.sha, blob.content));
}

async function writeContents(ctx: RequestContext, repo: Repo, path: string, mode: 'put' | 'delete'): Promise<void> {
  if (path === '') throw new HttpError(404, 'Not Found');
  const body = await readJsonBody(ctx.req);
  const branch = stringField(body.branch) ?? repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const existingRef = repo.refs.get(refName);
  const tip = existingRef === undefined ? null : ctx.store.resolveCommit(repo, refName);
  if (existingRef !== undefined && tip === null) throw new HttpError(404, 'Branch not found');
  if (tip === null && existingRef === undefined && repo.refs.size > 0) throw new HttpError(404, 'Branch not found');
  const files = tip === null ? new Map<string, Buffer>() : ctx.store.commitFiles(repo, tip);

  if (mode === 'delete') {
    if (!files.has(path)) throw new HttpError(404, 'Not Found');
    const currentSha = hashObject('blob', files.get(path) as Buffer);
    const supplied = stringField(body.sha);
    if (supplied !== undefined && supplied.toLowerCase() !== currentSha) {
      throw new HttpError(409, 'sha does not match');
    }
    files.delete(path);
  } else {
    if (typeof body.content !== 'string') {
      throw new HttpError(422, 'Validation Failed', {
        errors: [{ resource: 'Content', code: 'missing_field', field: 'content', message: 'content is required' }],
      });
    }
    const existed = files.has(path);
    if (existed) {
      const currentSha = hashObject('blob', files.get(path) as Buffer);
      const supplied = stringField(body.sha);
      if (supplied !== undefined && supplied.toLowerCase() !== currentSha) {
        throw new HttpError(409, 'sha does not match');
      }
    } else if (stringField(body.sha) !== undefined) {
      throw new HttpError(404, 'Not Found');
    }
    const content = Buffer.from(body.content.replace(/\s+/g, ''), 'base64');
    files.set(path, content);
  }

  const message = stringField(body.message) ?? (mode === 'delete' ? `Delete ${path}` : `Update ${path}`);
  const author = identityOf(body.author, ctx.store.viewer);
  const committer = identityOf(body.committer ?? body.author, ctx.store.viewer);
  const treeSha = buildTreeFromContents(repo.objects, files);
  const commitSha = putObject(
    repo.objects,
    'commit',
    buildCommit({
      tree: treeSha,
      parents: tip === null ? [] : [tip],
      message,
      author: author.identity,
      committer: committer.identity,
      timestamp: committer.timestamp,
    }),
  );
  repo.refs.set(refName, commitSha);
  const now = Date.now();
  repo.updatedAt = now;
  repo.pushedAt = now;

  if (mode === 'delete') {
    sendJson(ctx.res, 200, { content: null, commit: commitPayload(ctx, repo, commitSha) });
    return;
  }
  const blobSha = hashObject('blob', files.get(path) as Buffer);
  const existedAfter = tip === null ? false : ctx.store.commitFiles(repo, tip).has(path);
  sendJson(ctx.res, existedAfter ? 200 : 201, {
    content: fileReply(ctx, repo, branch, path, blobSha, files.get(path) as Buffer),
    commit: commitPayload(ctx, repo, commitSha),
  });
}

function contentsHandler(ctx: RequestContext, owner: string, name: string, rawPath: string | undefined): void | Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  const path = (rawPath ?? '').replace(/^\/+|\/+$/g, '');
  const method = ctx.req.method ?? 'GET';
  if (method === 'GET') {
    readContents(ctx, repo, path);
    return;
  }
  if (method === 'PUT') return writeContents(ctx, repo, path, 'put');
  if (method === 'DELETE') return writeContents(ctx, repo, path, 'delete');
  throw new HttpError(404, 'Not Found');
}

export function registerContentRoutes(register: (methods: readonly string[], pattern: RegExp, handler: RouteHandler) => void): void {
  register(['GET', 'PUT', 'DELETE'], /^\/repos\/([^/]+)\/([^/]+)\/contents(?:\/(.*))?$/, (ctx, params) =>
    contentsHandler(ctx, params[0] as string, params[1] as string, params[2]),
  );
}
