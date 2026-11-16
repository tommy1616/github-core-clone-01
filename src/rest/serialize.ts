// GitHub-shaped JSON for the store's objects: the REST replies the conformance suite reads and
// GraphQL/MCP will reuse. Every URL is absolute against the origin the request arrived on.

import type { Comment, Issue, Label, Pull, Repo, Store, User } from '../store.ts';
import { iso } from '../store.ts';

export function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function repoApiUrl(origin: string, repo: Repo): string {
  return `${origin}/api/v3/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}`;
}

const USER_JSON = new WeakMap<User, { readonly origin: string; readonly value: Record<string, unknown> }>();

export function serializeUser(origin: string, user: User): Record<string, unknown> {
  const cached = USER_JSON.get(user);
  if (cached !== undefined && cached.origin === origin) return cached.value;
  const login = encodeURIComponent(user.login);
  const value: Record<string, unknown> = {
    login: user.login,
    id: user.id,
    node_id: user.nodeId,
    avatar_url: `${origin}/avatars/u/${user.id}`,
    gravatar_id: '',
    url: `${origin}/api/v3/users/${login}`,
    html_url: `${origin}/${login}`,
    followers_url: `${origin}/api/v3/users/${login}/followers`,
    following_url: `${origin}/api/v3/users/${login}/following{/other_user}`,
    gists_url: `${origin}/api/v3/users/${login}/gists{/gist_id}`,
    starred_url: `${origin}/api/v3/users/${login}/starred{/owner}{/repo}`,
    subscriptions_url: `${origin}/api/v3/users/${login}/subscriptions`,
    organizations_url: `${origin}/api/v3/users/${login}/orgs`,
    repos_url: `${origin}/api/v3/users/${login}/repos`,
    events_url: `${origin}/api/v3/users/${login}/events{/privacy}`,
    received_events_url: `${origin}/api/v3/users/${login}/received_events`,
    type: 'User',
    site_admin: false,
    name: user.name,
    email: user.email,
  };
  USER_JSON.set(user, { origin, value });
  return value;
}

export function serializeRepo(origin: string, repo: Repo): Record<string, unknown> {
  const url = repoApiUrl(origin, repo);
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.owner.login}/${repo.name}`,
    private: repo.private,
    owner: serializeUser(origin, repo.owner),
    html_url: `${origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}`,
    description: repo.description,
    fork: false,
    url,
    forks_url: `${url}/forks`,
    keys_url: `${url}/keys{/key_id}`,
    collaborators_url: `${url}/collaborators{/collaborator}`,
    teams_url: `${url}/teams`,
    hooks_url: `${url}/hooks`,
    issue_events_url: `${url}/issues/events{/number}`,
    events_url: `${url}/events`,
    assignees_url: `${url}/assignees{/user}`,
    branches_url: `${url}/branches{/branch}`,
    tags_url: `${url}/tags`,
    blobs_url: `${url}/git/blobs{/sha}`,
    git_tags_url: `${url}/git/tags{/sha}`,
    git_refs_url: `${url}/git/refs{/sha}`,
    trees_url: `${url}/git/trees{/sha}`,
    statuses_url: `${url}/statuses/{sha}`,
    languages_url: `${url}/languages`,
    stargazers_url: `${url}/stargazers`,
    contributors_url: `${url}/contributors`,
    subscribers_url: `${url}/subscribers`,
    subscription_url: `${url}/subscription`,
    commits_url: `${url}/commits{/sha}`,
    git_commits_url: `${url}/git/commits{/sha}`,
    comments_url: `${url}/comments{/number}`,
    issue_comment_url: `${url}/issues/comments{/number}`,
    contents_url: `${url}/contents/{+path}`,
    compare_url: `${url}/compare/{base}...{head}`,
    merges_url: `${url}/merges`,
    archive_url: `${url}/{archive_format}{/ref}`,
    downloads_url: `${url}/downloads`,
    issues_url: `${url}/issues{/number}`,
    pulls_url: `${url}/pulls{/number}`,
    milestones_url: `${url}/milestones{/number}`,
    notifications_url: `${url}/notifications{?since,all,participating}`,
    labels_url: `${url}/labels{/name}`,
    releases_url: `${url}/releases{/id}`,
    deployments_url: `${url}/deployments`,
    created_at: iso(repo.createdAt),
    updated_at: iso(repo.updatedAt),
    pushed_at: iso(repo.pushedAt),
    git_url: `git://${hostOf(origin)}/${repo.owner.login}/${repo.name}.git`,
    ssh_url: `git@${hostOf(origin)}:${repo.owner.login}/${repo.name}.git`,
    clone_url: `${origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}.git`,
    svn_url: `${origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.size + repo.pulls.size,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: repo.issues.size + repo.pulls.size,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

/** The compact repository object nested in a pull's head and base. */
export function miniRepo(origin: string, repo: Repo): Record<string, unknown> {
  const url = repoApiUrl(origin, repo);
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.owner.login}/${repo.name}`,
    private: repo.private,
    owner: serializeUser(origin, repo.owner),
    html_url: `${origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}`,
    description: repo.description,
    fork: false,
    url,
    default_branch: repo.defaultBranch,
  };
}

function hostOf(origin: string): string {
  return origin.replace(/^https?:\/\//, '');
}

export function serializeLabel(origin: string, repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: label.nodeId,
    url: `${repoApiUrl(origin, repo)}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: label.default,
    description: label.description,
  };
}

interface IssueJsonCacheEntry {
  readonly version: number;
  readonly origin: string;
  readonly repoName: string;
  readonly owner: string;
  readonly comments: number;
  readonly updatedAt: number;
  readonly labels: string;
  readonly text: string;
  readonly buffer: Buffer;
}

const ISSUE_JSON_CACHE = new WeakMap<Issue, IssueJsonCacheEntry>();

/** The issue's JSON text and buffer, reused until the issue, its labels or its repository change. */
export function serializeIssueJson(origin: string, repo: Repo, issue: Issue): { readonly text: string; readonly buffer: Buffer } {
  const labels =
    issue.labels.length === 0
      ? ''
      : issue.labels
          .map((name) => {
            const label = repo.labels.get(name.toLowerCase());
            return label === undefined ? `?${name}` : `${label.id}:${label.name}:${label.color}:${label.description}`;
          })
          .join('\u0001');
  const cached = ISSUE_JSON_CACHE.get(issue);
  if (
    cached !== undefined &&
    cached.version === issue.version &&
    cached.origin === origin &&
    cached.repoName === repo.name &&
    cached.owner === repo.owner.login &&
    cached.comments === issue.comments.length &&
    cached.updatedAt === issue.updatedAt &&
    cached.labels === labels
  ) {
    return cached;
  }
  const text = JSON.stringify(serializeIssue(origin, repo, issue));
  const entry: IssueJsonCacheEntry = {
    version: issue.version,
    origin,
    repoName: repo.name,
    owner: repo.owner.login,
    comments: issue.comments.length,
    updatedAt: issue.updatedAt,
    labels,
    text,
    buffer: Buffer.from(text, 'utf8'),
  };
  ISSUE_JSON_CACHE.set(issue, entry);
  return entry;
}

export function serializeIssue(origin: string, repo: Repo, issue: Issue): Record<string, unknown> {
  const url = `${repoApiUrl(origin, repo)}/issues/${issue.number}`;
  const labels: Record<string, unknown>[] = [];
  for (const name of issue.labels) {
    const label = repo.labels.get(name.toLowerCase());
    if (label !== undefined) labels.push(serializeLabel(origin, repo, label));
  }
  return {
    id: issue.id,
    node_id: issue.nodeId,
    url,
    repository_url: repoApiUrl(origin, repo),
    labels_url: `${url}/labels{/name}`,
    comments_url: `${url}/comments`,
    events_url: `${url}/events`,
    html_url: `${origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    state_reason: issue.state === 'closed' ? 'completed' : null,
    title: issue.title,
    body: issue.body,
    user: serializeUser(origin, issue.user),
    labels,
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    active_lock_reason: null,
    comments: issue.comments.length,
    pull_request: undefined,
    closed_at: issue.closedAt === null ? null : iso(issue.closedAt),
    created_at: iso(issue.createdAt),
    updated_at: iso(issue.updatedAt),
    closed_by: issue.state === 'closed' ? serializeUser(origin, issue.user) : null,
    author_association: 'OWNER',
    performed_via_github_app: null,
  };
}

export function serializeComment(origin: string, repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  const issueUrl = `${repoApiUrl(origin, repo)}/issues/${issue.number}`;
  return {
    id: comment.id,
    node_id: comment.nodeId,
    url: `${repoApiUrl(origin, repo)}/issues/comments/${comment.id}`,
    html_url: `${origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: issueUrl,
    user: serializeUser(origin, comment.user),
    created_at: iso(comment.createdAt),
    updated_at: iso(comment.updatedAt),
    author_association: 'OWNER',
    body: comment.body,
    performed_via_github_app: null,
  };
}

export interface PullExtras {
  readonly mergeable?: boolean | null;
  readonly additions?: number;
  readonly deletions?: number;
  readonly changedFiles?: number;
  readonly commits?: number;
}

export function serializePull(origin: string, store: Store, repo: Repo, pull: Pull, extras: PullExtras = {}): Record<string, unknown> {
  const url = `${repoApiUrl(origin, repo)}/pulls/${pull.number}`;
  const headSha = store.resolveCommit(repo, pull.headRef) ?? pull.headShaAtCreate;
  const baseSha = store.resolveCommit(repo, pull.baseRef) ?? pull.baseShaAtCreate;
  const owner = repo.owner.login;
  return {
    id: pull.id,
    node_id: pull.nodeId,
    url,
    html_url: `${origin}/${encodeURIComponent(owner)}/${encodeURIComponent(repo.name)}/pull/${pull.number}`,
    diff_url: `${url}.diff`,
    patch_url: `${url}.patch`,
    issue_url: `${repoApiUrl(origin, repo)}/issues/${pull.number}`,
    number: pull.number,
    state: pull.merged ? 'closed' : pull.state,
    locked: false,
    title: pull.title,
    user: serializeUser(origin, pull.user),
    body: pull.body,
    created_at: iso(pull.createdAt),
    updated_at: iso(pull.updatedAt),
    closed_at: pull.mergedAt === null ? null : iso(pull.mergedAt),
    merged_at: pull.mergedAt === null ? null : iso(pull.mergedAt),
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: `${url}/commits`,
    review_comments_url: `${url}/comments`,
    review_comment_url: `${url}/comments{/comment_id}`,
    comments_url: `${url}/comments`,
    statuses_url: `${url}/statuses/{sha}`,
    head: {
      label: `${owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headSha,
      user: serializeUser(origin, repo.owner),
      repo: miniRepo(origin, repo),
    },
    base: {
      label: `${owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseSha,
      user: serializeUser(origin, repo.owner),
      repo: miniRepo(origin, repo),
    },
    _links: {
      self: { href: url },
      html: { href: `${origin}/${encodeURIComponent(owner)}/${encodeURIComponent(repo.name)}/pull/${pull.number}` },
      issue: { href: `${repoApiUrl(origin, repo)}/issues/${pull.number}` },
      comments: { href: `${url}/comments` },
      review_comments: { href: `${url}/comments` },
      review_comment: { href: `${url}/comments{/number}` },
      commits: { href: `${url}/commits` },
      statuses: { href: `${url}/statuses/{sha}` },
    },
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
    merged: pull.merged,
    mergeable: extras.mergeable ?? true,
    rebaseable: null,
    mergeable_state: extras.mergeable === false ? 'dirty' : 'clean',
    merged_by: pull.merged ? serializeUser(origin, pull.user) : null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: extras.commits ?? 0,
    additions: extras.additions ?? 0,
    deletions: extras.deletions ?? 0,
    changed_files: extras.changedFiles ?? 0,
  };
}

export function serializeCommit(origin: string, repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const text = object.content.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headers = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of headers.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  const parseIdentity = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (match === null) return { name: line, email: '', date: iso(0) };
    return {
      name: match[1] as string,
      email: match[2] as string,
      date: iso(Number(match[3]) * 1000),
    };
  };
  const url = `${repoApiUrl(origin, repo)}/commits/${sha}`;
  return {
    sha,
    node_id: Buffer.from(`010:Commit${sha}`, 'utf8').toString('base64'),
    url,
    html_url: `${origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/commit/${sha}`,
    comments_url: `${url}/comments`,
    commit: {
      author: parseIdentity(authorLine),
      committer: parseIdentity(committerLine),
      message,
      tree: { sha: tree, url: `${repoApiUrl(origin, repo)}/git/trees/${tree}` },
      url,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
    },
    author: serializeUser(origin, repo.owner),
    committer: serializeUser(origin, repo.owner),
    parents: parents.map((parent) => ({
      sha: parent,
      url: `${repoApiUrl(origin, repo)}/commits/${parent}`,
      html_url: `${origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/commit/${parent}`,
    })),
  };
}
