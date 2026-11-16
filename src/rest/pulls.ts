// Pull requests: create, read, list, the files a pull changes, and the squash merge. The files and
// the merge are computed from the repository's real trees; a conflict is a three-way merge that
// finds a path both sides changed differently.

import {
  HttpError,
  queryInt,
  readJsonBody,
  sendJson,
  stringField,
  type RequestContext,
} from '../http.ts';
import type { Pull, Repo, Store } from '../store.ts';
import { buildCommit, buildTreeFromContents, putObject } from '../git/objects.ts';
import { diffTrees, isMergeable, threeWayMerge, type FileDiff } from './diff.ts';
import { repoApiUrl, serializePull, type PullExtras } from './serialize.ts';
import { repoOr404 } from './repos.ts';
import type { RouteHandler } from './index.ts';

function pullOr404(repo: Repo, number: number): Pull {
  const pull = repo.pulls.get(number);
  if (pull === undefined) throw new HttpError(404, 'Not Found');
  return pull;
}

function pullDiff(store: Store, repo: Repo, pull: Pull): FileDiff[] {
  const head = store.resolveCommit(repo, pull.headRef);
  const base = store.resolveCommit(repo, pull.baseRef);
  if (head === null || base === null) return [];
  const mergeBase = store.mergeBase(repo, head, base);
  return diffTrees(repo, base, head, mergeBase);
}

function extrasFor(store: Store, repo: Repo, pull: Pull): PullExtras {
  const files = pullDiff(store, repo, pull);
  const head = store.resolveCommit(repo, pull.headRef);
  const base = store.resolveCommit(repo, pull.baseRef);
  let commits = 0;
  if (head !== null && base !== null) {
    const baseAncestors = new Set(store.walkCommits(repo, base));
    commits = store.walkCommits(repo, head).filter((sha) => !baseAncestors.has(sha)).length;
  }
  return {
    mergeable: pull.merged ? false : isMergeable(store, repo, pull.headRef, pull.baseRef),
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    changedFiles: files.length,
    commits,
  };
}

async function pullsHandler(ctx: RequestContext, owner: string, name: string): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if ((ctx.req.method ?? 'GET') === 'POST') {
    const body = await readJsonBody(ctx.req);
    const title = stringField(body.title);
    if (title === undefined || title.trim() === '') {
      throw new HttpError(422, 'Validation Failed', {
        errors: [{ resource: 'PullRequest', code: 'missing_field', field: 'title', message: 'title is required' }],
      });
    }
    const rawHead = stringField(body.head);
    if (rawHead === undefined || rawHead === '') {
      throw new HttpError(422, 'Validation Failed', {
        errors: [{ resource: 'PullRequest', code: 'missing_field', field: 'head', message: 'head is required' }],
      });
    }
    const headRef = rawHead.includes(':') ? (rawHead.split(':').pop() as string) : rawHead;
    const baseRef = stringField(body.base) ?? repo.defaultBranch;
    const headSha = ctx.store.resolveCommit(repo, headRef);
    const baseSha = ctx.store.resolveCommit(repo, baseRef);
    if (headSha === null) {
      throw new HttpError(422, 'Validation Failed', {
        errors: [{ resource: 'PullRequest', code: 'custom', field: 'head', message: 'head branch does not exist' }],
      });
    }
    if (baseSha === null) {
      throw new HttpError(422, 'Validation Failed', {
        errors: [{ resource: 'PullRequest', code: 'custom', field: 'base', message: 'base branch does not exist' }],
      });
    }
    const text = body.body === null || body.body === undefined ? '' : stringField(body.body) ?? '';
    const pull = ctx.store.createPull(repo, { title, body: text, headRef, baseRef, headSha, baseSha });
    sendJson(ctx.res, 201, serializePull(ctx.origin, ctx.store, repo, pull, extrasFor(ctx.store, repo, pull)));
    return;
  }

  const state = ctx.url.searchParams.get('state') ?? 'open';
  const perPage = queryInt(ctx.url, 'per_page', 30, 1, 100);
  const page = queryInt(ctx.url, 'page', 1, 1, 1_000_000);
  let pulls = [...repo.pulls.values()];
  if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => (b.seq - a.seq || b.number - a.number));
  const start = (page - 1) * perPage;
  const slice = pulls.slice(start, start + perPage);
  sendJson(
    ctx.res,
    200,
    slice.map((pull) => serializePull(ctx.origin, ctx.store, repo, pull)),
  );
}

function pullHandler(ctx: RequestContext, owner: string, name: string, rawNumber: string): void {
  const repo = repoOr404(ctx, owner, name);
  const pull = pullOr404(repo, Number(rawNumber));
  sendJson(ctx.res, 200, serializePull(ctx.origin, ctx.store, repo, pull, extrasFor(ctx.store, repo, pull)));
}

function filesHandler(ctx: RequestContext, owner: string, name: string, rawNumber: string): void {
  const repo = repoOr404(ctx, owner, name);
  const pull = pullOr404(repo, Number(rawNumber));
  const files = pullDiff(ctx.store, repo, pull).map((file) => ({
    sha: file.sha,
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    blob_url: `${repoApiUrl(ctx.origin, repo)}/git/blobs/${file.sha}`,
    raw_url: `${ctx.origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/raw/${encodeURIComponent(pull.headRef)}/${file.filename.split('/').map(encodeURIComponent).join('/')}`,
    contents_url: `${repoApiUrl(ctx.origin, repo)}/contents/${file.filename.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(pull.headRef)}`,
  }));
  sendJson(ctx.res, 200, files);
}

async function mergeHandler(ctx: RequestContext, owner: string, name: string, rawNumber: string): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  const pull = pullOr404(repo, Number(rawNumber));
  await readJsonBody(ctx.req);
  if (pull.merged || pull.state === 'closed') {
    throw new HttpError(405, 'Pull Request is not mergeable', { documentation_url: `${ctx.origin}/api/v3/repos` });
  }
  const headSha = ctx.store.resolveCommit(repo, pull.headRef);
  const baseSha = ctx.store.resolveCommit(repo, pull.baseRef);
  if (headSha === null || baseSha === null) {
    throw new HttpError(405, 'Pull Request is not mergeable');
  }
  const mergeBase = ctx.store.mergeBase(repo, headSha, baseSha);
  if (mergeBase === null) throw new HttpError(405, 'Pull Request is not mergeable');
  const merged = threeWayMerge(ctx.store, repo, baseSha, headSha, mergeBase);
  if (!merged.ok) {
    throw new HttpError(405, 'Pull Request is not mergeable', { conflicts: merged.conflicts });
  }
  const tree = buildTreeFromContents(repo.objects, merged.files);
  const viewer = ctx.store.viewer;
  const commitSha = putObject(
    repo.objects,
    'commit',
    buildCommit({
      tree,
      parents: [baseSha],
      message: `${pull.title} (#${pull.number})`,
      author: { name: viewer.name, email: viewer.email },
    }),
  );
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
  const now = Date.now();
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = now;
  pull.mergeCommitSha = commitSha;
  pull.updatedAt = now;
  repo.updatedAt = now;
  repo.pushedAt = now;
  sendJson(ctx.res, 200, { sha: commitSha, merged: true, message: 'Pull Request successfully merged' });
}

function pullCommits(ctx: RequestContext, owner: string, name: string, rawNumber: string): void {
  const repo = repoOr404(ctx, owner, name);
  const pull = pullOr404(repo, Number(rawNumber));
  const head = ctx.store.resolveCommit(repo, pull.headRef);
  const base = ctx.store.resolveCommit(repo, pull.baseRef);
  const baseSet = base === null ? new Set<string>() : new Set(ctx.store.walkCommits(repo, base));
  const shas = head === null ? [] : ctx.store.walkCommits(repo, head).filter((sha) => !baseSet.has(sha));
  const commits = shas
    .map((sha) => {
      const object = repo.objects.get(sha);
      if (object === undefined || object.type !== 'commit') return null;
      const text = object.content.toString('utf8');
      const blank = text.indexOf('\n\n');
      return {
        sha,
        node_id: Buffer.from(`010:Commit${sha}`, 'utf8').toString('base64'),
        url: `${repoApiUrl(ctx.origin, repo)}/commits/${sha}`,
        html_url: `${ctx.origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/commit/${sha}`,
        commit: {
          message: blank < 0 ? '' : text.slice(blank + 2),
          tree: { sha: '' },
        },
        parents: [],
      };
    })
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  sendJson(ctx.res, 200, commits);
}

export function registerPullRoutes(register: (methods: readonly string[], pattern: RegExp, handler: RouteHandler) => void): void {
  register(['GET', 'POST'], /^\/repos\/([^/]+)\/([^/]+)\/pulls$/, (ctx, params) =>
    pullsHandler(ctx, params[0] as string, params[1] as string),
  );
  register(['GET'], /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/, (ctx, params) =>
    pullHandler(ctx, params[0] as string, params[1] as string, params[2] as string),
  );
  register(['GET'], /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files$/, (ctx, params) =>
    filesHandler(ctx, params[0] as string, params[1] as string, params[2] as string),
  );
  register(['GET'], /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/commits$/, (ctx, params) =>
    pullCommits(ctx, params[0] as string, params[1] as string, params[2] as string),
  );
  register(['PUT', 'POST'], /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/, (ctx, params) =>
    mergeHandler(ctx, params[0] as string, params[1] as string, params[2] as string),
  );
}
