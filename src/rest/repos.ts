// Repositories, branches, commits and the low-level git refs/commits/trees routes. The other REST
// modules import repoOr404 so every one of them resolves owner and name the same way.

import {
  HttpError,
  booleanField,
  queryInt,
  readJsonBody,
  sendEmpty,
  sendJson,
  stringField,
  type RequestContext,
} from '../http.ts';
import { iso, type Repo } from '../store.ts';
import { parseCommit, parseTree } from '../git/objects.ts';
import { repoApiUrl, serializeCommit, serializeRepo, serializeUser } from './serialize.ts';
import type { RouteHandler } from './index.ts';

export function repoOr404(ctx: RequestContext, owner: string, name: string): Repo {
  const repo = ctx.store.requireRepo(owner, name);
  if (repo === undefined) throw new HttpError(404, 'Not Found');
  return repo;
}

function pageOf<T>(items: readonly T[], perPage: number, page: number): T[] {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

function pageLinks(ctx: RequestContext, basePath: string, perPage: number, page: number, total: number): Record<string, string> {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const links: string[] = [];
  const link = (target: number, rel: string): string => `<${ctx.origin}${basePath}?per_page=${perPage}&page=${target}>; rel="${rel}"`;
  if (page < lastPage) links.push(link(page + 1, 'next'), link(lastPage, 'last'));
  if (page > 1) links.push(link(1, 'first'), link(page - 1, 'prev'));
  return links.length === 0 ? {} : { link: links.join(', ') };
}

function validRepoName(name: string): boolean {
  return name.length > 0 && name.length <= 100 && /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..';
}

function repoRoot(ctx: RequestContext): void {
  sendJson(
    ctx.res,
    200,
    {
      current_user_url: `${ctx.origin}/api/v3/user`,
      current_user_authorizations_html_url: `${ctx.origin}/settings/connections/applications{/client_id}`,
      authorizations_url: `${ctx.origin}/api/v3/authorizations`,
      code_search_url: `${ctx.origin}/api/v3/search/code?q={query}{&page,per_page,sort,order}`,
      commit_search_url: `${ctx.origin}/api/v3/search/commits?q={query}{&page,per_page,sort,order}`,
      emails_url: `${ctx.origin}/api/v3/user/emails`,
      emojis_url: `${ctx.origin}/api/v3/emojis`,
      events_url: `${ctx.origin}/api/v3/events`,
      feeds_url: `${ctx.origin}/api/v3/feeds`,
      followers_url: `${ctx.origin}/api/v3/user/followers`,
      following_url: `${ctx.origin}/api/v3/user/following{/target}`,
      gists_url: `${ctx.origin}/api/v3/gists{/gist_id}`,
      hub_url: `${ctx.origin}/api/v3/hub`,
      issue_search_url: `${ctx.origin}/api/v3/search/issues?q={query}{&page,per_page,sort,order}`,
      issues_url: `${ctx.origin}/api/v3/issues`,
      keys_url: `${ctx.origin}/api/v3/user/keys{/key_id}`,
      label_search_url: `${ctx.origin}/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}`,
      notifications_url: `${ctx.origin}/api/v3/notifications`,
      organization_url: `${ctx.origin}/api/v3/orgs/{org}`,
      organization_repositories_url: `${ctx.origin}/api/v3/orgs/{org}/repos{?type,page,per_page,sort}`,
      organization_teams_url: `${ctx.origin}/api/v3/orgs/{org}/teams`,
      public_gists_url: `${ctx.origin}/api/v3/gists/public`,
      rate_limit_url: `${ctx.origin}/api/v3/rate_limit`,
      repository_url: `${ctx.origin}/api/v3/repos/{owner}/{repo}`,
      repository_search_url: `${ctx.origin}/api/v3/search/repositories?q={query}{&page,per_page,sort,order}`,
      current_user_repositories_url: `${ctx.origin}/api/v3/user/repos{?type,page,per_page,sort}`,
      starred_url: `${ctx.origin}/api/v3/user/starred{/owner}{/repo}`,
      starred_gists_url: `${ctx.origin}/api/v3/gists/starred`,
      team_url: `${ctx.origin}/api/v3/teams`,
      user_url: `${ctx.origin}/api/v3/users/{user}`,
      user_organizations_url: `${ctx.origin}/api/v3/user/orgs`,
      user_repositories_url: `${ctx.origin}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
      user_search_url: `${ctx.origin}/api/v3/search/users?q={query}{&page,per_page,sort,order}`,
    },
    { 'x-oauth-scopes': 'repo, read:org' },
  );
}

function repoMeta(ctx: RequestContext): void {
  sendJson(ctx.res, 200, {
    verifiable_password_authentication: false,
    ssh_key_fingerprints: {},
    hooks: [`${ctx.origin}/api/v3/hooks`],
    git: [`${ctx.origin}/api/v3/git`],
    installed_version: '1.0.0',
  });
}

function currentUser(ctx: RequestContext): void {
  sendJson(ctx.res, 200, serializeUser(ctx.origin, ctx.store.viewer));
}

function publicUser(ctx: RequestContext, login: string): void {
  if (login.toLowerCase() !== ctx.store.viewer.login.toLowerCase()) throw new HttpError(404, 'Not Found');
  sendJson(ctx.res, 200, serializeUser(ctx.origin, ctx.store.viewer));
}

async function userRepos(ctx: RequestContext): Promise<void> {
  if ((ctx.req.method ?? 'GET') === 'POST') {
    const body = await readJsonBody(ctx.req);
    const name = stringField(body.name);
    if (name === undefined || !validRepoName(name)) {
      throw new HttpError(422, 'Repository creation failed.', {
        errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name is invalid' }],
      });
    }
    const description = body.description === null ? null : stringField(body.description) ?? null;
    if (ctx.store.findRepo(ctx.store.viewer.login, name) !== undefined) {
      throw new HttpError(422, 'Repository creation failed.', {
        errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
      });
    }
    const repo = ctx.store.createRepo(name, { description, private: booleanField(body.private) ?? false });
    sendJson(ctx.res, 201, serializeRepo(ctx.origin, repo));
    return;
  }

  const perPage = queryInt(ctx.url, 'per_page', 30, 1, 100);
  const page = queryInt(ctx.url, 'page', 1, 1, 1_000_000);
  const sort = ctx.url.searchParams.get('sort') ?? 'full_name';
  const direction = ctx.url.searchParams.get('direction') ?? 'asc';
  const repos = ctx.store.listRepos({ sort, direction });
  const slice = pageOf(repos, perPage, page);
  sendJson(
    ctx.res,
    200,
    slice.map((repo) => serializeRepo(ctx.origin, repo)),
    pageLinks(ctx, '/api/v3/user/repos', perPage, page, repos.length),
  );
}

async function oneRepo(ctx: RequestContext, owner: string, name: string): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  const method = ctx.req.method ?? 'GET';
  if (method === 'GET') {
    sendJson(ctx.res, 200, serializeRepo(ctx.origin, repo));
    return;
  }
  if (method === 'PATCH') {
    const body = await readJsonBody(ctx.req);
    if ('description' in body) {
      repo.description = body.description === null ? null : stringField(body.description) ?? repo.description;
    }
    if (typeof body.private === 'boolean') repo.private = body.private;
    const newName = stringField(body.name);
    if (newName !== undefined && newName !== repo.name) {
      if (!validRepoName(newName) || ctx.store.findRepo(owner, newName) !== undefined) {
        throw new HttpError(422, 'Repository creation failed.', {
          errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
        });
      }
      const oldName = repo.name;
      repo.name = newName;
      ctx.store.renameRepoKey(repo, oldName);
    }
    const branch = stringField(body.default_branch);
    if (branch !== undefined && branch !== '') repo.defaultBranch = branch;
    repo.updatedAt = Date.now();
    sendJson(ctx.res, 200, serializeRepo(ctx.origin, repo));
    return;
  }
  if (method === 'DELETE') {
    ctx.store.deleteRepo(repo);
    sendEmpty(ctx.res, 204);
    return;
  }
  throw new HttpError(404, 'Not Found');
}

function listBranches(ctx: RequestContext, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  const branches = ctx.store.listBranches(repo).map((branch) => ({
    name: branch.name,
    commit: {
      sha: branch.sha,
      url: `${repoApiUrl(ctx.origin, repo)}/commits/${branch.sha}`,
      html_url: `${ctx.origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/commit/${branch.sha}`,
    },
    protected: false,
    protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } },
    protection_url: `${repoApiUrl(ctx.origin, repo)}/branches/${encodeURIComponent(branch.name)}/protection`,
  }));
  sendJson(ctx.res, 200, branches);
}

function oneBranch(ctx: RequestContext, owner: string, name: string, branch: string): void {
  const repo = repoOr404(ctx, owner, name);
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) throw new HttpError(404, 'Branch not found');
  sendJson(ctx.res, 200, {
    name: branch,
    commit: {
      sha,
      url: `${repoApiUrl(ctx.origin, repo)}/commits/${sha}`,
      html_url: `${ctx.origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/commit/${sha}`,
    },
    protected: false,
    protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } },
    protection_url: `${repoApiUrl(ctx.origin, repo)}/branches/${encodeURIComponent(branch)}/protection`,
    _links: { self: `${repoApiUrl(ctx.origin, repo)}/branches/${encodeURIComponent(branch)}`, html: `${ctx.origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/tree/${encodeURIComponent(branch)}` },
  });
}

function listCommits(ctx: RequestContext, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  const ref = ctx.url.searchParams.get('sha') ?? repo.defaultBranch;
  const tip = ctx.store.resolveCommit(repo, ref);
  if (tip === null) {
    if (repo.refs.size === 0) throw new HttpError(409, 'Git Repository is empty.');
    throw new HttpError(404, 'Not Found');
  }
  const perPage = queryInt(ctx.url, 'per_page', 30, 1, 100);
  const page = queryInt(ctx.url, 'page', 1, 1, 1_000_000);
  const all = ctx.store.walkCommits(repo, tip);
  const slice = pageOf(all, perPage, page);
  const payload = slice
    .map((sha) => serializeCommit(ctx.origin, repo, sha))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  sendJson(ctx.res, 200, payload, pageLinks(ctx, `${repoApiUrl(ctx.origin, repo).slice(ctx.origin.length)}/commits`, perPage, page, all.length));
}

function oneCommit(ctx: RequestContext, owner: string, name: string, ref: string): void {
  const repo = repoOr404(ctx, owner, name);
  const sha = ctx.store.resolveCommit(repo, ref);
  if (sha === null) throw new HttpError(404, 'Not Found');
  const commit = serializeCommit(ctx.origin, repo, sha);
  if (commit === null) throw new HttpError(404, 'Not Found');
  sendJson(ctx.res, 200, commit);
}

function refNameOf(rest: string): string {
  if (rest.startsWith('refs/')) return rest;
  if (rest.startsWith('heads/')) return `refs/${rest}`;
  if (rest.startsWith('tags/')) return `refs/${rest}`;
  return rest;
}

function refPayload(ctx: RequestContext, repo: Repo, ref: string, sha: string): Record<string, unknown> {
  const object = repo.objects.get(sha);
  return {
    ref,
    node_id: Buffer.from(`010:Ref${ref}`, 'utf8').toString('base64'),
    url: `${repoApiUrl(ctx.origin, repo)}/git/refs/${ref}`,
    object: {
      type: object?.type ?? 'commit',
      sha,
      url: `${repoApiUrl(ctx.origin, repo)}/git/${object?.type === 'tag' ? 'tags' : 'commits'}/${sha}`,
    },
  };
}

async function gitRefs(ctx: RequestContext, owner: string, name: string): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  const method = ctx.req.method ?? 'GET';
  if (method === 'GET') {
    const refs = [...repo.refs.entries()].map(([ref, sha]) => refPayload(ctx, repo, ref, sha));
    sendJson(ctx.res, 200, refs);
    return;
  }
  const body = await readJsonBody(ctx.req);
  const ref = stringField(body.ref);
  const sha = stringField(body.sha);
  if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) {
    throw new HttpError(422, 'Reference update failed', {
      errors: [{ resource: 'GitRef', code: 'custom', message: 'ref and sha are required' }],
    });
  }
  const object = repo.objects.get(sha);
  if (object === undefined || (object.type !== 'commit' && object.type !== 'tag')) {
    throw new HttpError(422, 'Reference update failed', {
      errors: [{ resource: 'GitRef', code: 'custom', field: 'sha', message: 'Object does not exist' }],
    });
  }
  if (repo.refs.has(ref)) {
    throw new HttpError(422, 'Reference already exists', {
      errors: [{ resource: 'GitRef', code: 'custom', field: 'ref', message: 'Reference already exists' }],
    });
  }
  repo.refs.set(ref, sha);
  repo.updatedAt = Date.now();
  sendJson(ctx.res, 201, refPayload(ctx, repo, ref, sha));
}

function oneRef(ctx: RequestContext, owner: string, name: string, rest: string): void {
  const repo = repoOr404(ctx, owner, name);
  const ref = refNameOf(rest);
  const sha = repo.refs.get(ref);
  if (sha === undefined) throw new HttpError(404, 'Not Found');
  sendJson(ctx.res, 200, refPayload(ctx, repo, ref, sha));
}

function gitCommit(ctx: RequestContext, owner: string, name: string, sha: string): void {
  const repo = repoOr404(ctx, owner, name);
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') throw new HttpError(404, 'Not Found');
  const parsed = parseCommit(object.content);
  sendJson(ctx.res, 200, {
    sha,
    node_id: Buffer.from(`010:Commit${sha}`, 'utf8').toString('base64'),
    url: `${repoApiUrl(ctx.origin, repo)}/git/commits/${sha}`,
    html_url: `${ctx.origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/commit/${sha}`,
    author: { name: repo.owner.name, email: repo.owner.email, date: iso(0) },
    committer: { name: repo.owner.name, email: repo.owner.email, date: iso(0) },
    tree: { sha: parsed.tree, url: `${repoApiUrl(ctx.origin, repo)}/git/trees/${parsed.tree}` },
    message: parsed.message,
    parents: parsed.parents.map((parent) => ({ sha: parent, url: `${repoApiUrl(ctx.origin, repo)}/git/commits/${parent}` })),
    verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
  });
}

function gitTree(ctx: RequestContext, owner: string, name: string, sha: string): void {
  const repo = repoOr404(ctx, owner, name);
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'tree') throw new HttpError(404, 'Not Found');
  const recursive = ctx.url.searchParams.get('recursive') === '1';
  const entries: Record<string, unknown>[] = [];
  const walk = (treeSha: string, prefix: string): void => {
    const tree = repo.objects.get(treeSha);
    if (tree === undefined || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.content)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const child = repo.objects.get(entry.sha);
      entries.push({
        path,
        mode: entry.mode,
        type: entry.mode === '40000' ? 'tree' : entry.mode === '160000' ? 'commit' : 'blob',
        sha: entry.sha,
        size: child !== undefined && child.type === 'blob' ? child.content.length : undefined,
        url: `${repoApiUrl(ctx.origin, repo)}/git/${entry.mode === '40000' ? 'trees' : 'blobs'}/${entry.sha}`,
      });
      if (recursive && entry.mode === '40000') walk(entry.sha, path);
    }
  };
  walk(sha, '');
  sendJson(ctx.res, 200, { sha, url: `${repoApiUrl(ctx.origin, repo)}/git/trees/${sha}`, tree: entries, truncated: false });
}

export function registerRepoRoutes(register: (methods: readonly string[], pattern: RegExp, handler: RouteHandler) => void): void {
  register(['GET'], /^\/$/, repoRoot);
  register(['GET'], /^\/meta$/, repoMeta);
  register(['GET'], /^\/user$/, currentUser);
  register(['GET', 'POST'], /^\/user\/repos$/, userRepos);
  register(['GET'], /^\/users\/([^/]+)$/, (ctx, params) => publicUser(ctx, params[0] as string));
  register(['GET', 'PATCH', 'DELETE'], /^\/repos\/([^/]+)\/([^/]+)$/, (ctx, params) =>
    oneRepo(ctx, params[0] as string, params[1] as string),
  );
  register(['GET'], /^\/repos\/([^/]+)\/([^/]+)\/branches$/, (ctx, params) =>
    listBranches(ctx, params[0] as string, params[1] as string),
  );
  register(['GET'], /^\/repos\/([^/]+)\/([^/]+)\/branches\/(.+)$/, (ctx, params) =>
    oneBranch(ctx, params[0] as string, params[1] as string, params[2] as string),
  );
  register(['GET'], /^\/repos\/([^/]+)\/([^/]+)\/commits$/, (ctx, params) =>
    listCommits(ctx, params[0] as string, params[1] as string),
  );
  register(['GET'], /^\/repos\/([^/]+)\/([^/]+)\/commits\/([^/]+)$/, (ctx, params) =>
    oneCommit(ctx, params[0] as string, params[1] as string, params[2] as string),
  );
  register(['GET', 'POST'], /^\/repos\/([^/]+)\/([^/]+)\/git\/refs$/, (ctx, params) =>
    gitRefs(ctx, params[0] as string, params[1] as string),
  );
  register(['GET'], /^\/repos\/([^/]+)\/([^/]+)\/git\/refs\/(.+)$/, (ctx, params) =>
    oneRef(ctx, params[0] as string, params[1] as string, params[2] as string),
  );
  register(['GET'], /^\/repos\/([^/]+)\/([^/]+)\/git\/commits\/([0-9a-f]{40})$/, (ctx, params) =>
    gitCommit(ctx, params[0] as string, params[1] as string, params[2] as string),
  );
  register(['GET'], /^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/([0-9a-f]{40})$/, (ctx, params) =>
    gitTree(ctx, params[0] as string, params[1] as string, params[2] as string),
  );
}
