// The trial's whole world: users, repositories, their git object databases and refs, labels,
// issues, comments and pull requests. It lives in the one process for the life of the trial;
// nothing is persisted. Ids and node ids come from counters, never from randomness.

import {
  type GitObject,
  type ObjectDatabase,
  commitParentsOf,
  commitTreeOf,
  parseTag,
  readTreeContents,
} from './git/objects.ts';

export interface User {
  readonly id: number;
  readonly nodeId: string;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

export interface Label {
  readonly id: number;
  readonly nodeId: string;
  readonly name: string;
  readonly color: string;
  readonly description: string;
  readonly default: boolean;
}

export interface Comment {
  readonly id: number;
  readonly nodeId: string;
  readonly body: string;
  readonly user: User;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Issue {
  readonly id: number;
  readonly nodeId: string;
  readonly seq: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly user: User;
  readonly createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  readonly comments: Comment[];
}

export interface Pull {
  readonly id: number;
  readonly nodeId: string;
  readonly seq: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly headRef: string;
  readonly baseRef: string;
  readonly headShaAtCreate: string;
  readonly baseShaAtCreate: string;
  readonly user: User;
  readonly createdAt: number;
  updatedAt: number;
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
}

export interface Repo {
  readonly id: number;
  readonly nodeId: string;
  readonly seq: number;
  name: string;
  readonly owner: User;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  readonly createdAt: number;
  updatedAt: number;
  pushedAt: number;
  readonly objects: ObjectDatabase;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, Pull>;
  nextNumber: number;
}

// The suite's fixed scenario (kit wire.ts buildScenario) names its viewer adaiversen; the bearer
// token is that user, and every user repository is owned by this login.
export const TOKEN_LOGIN = 'adaiversen';
export const TOKEN_USER_NAME = 'ada iversen';
export const TOKEN_USER_EMAIL = 'adaiversen@example.invalid';
export const TOKEN_USER_ID = 1000;

export function nodeId(kind: string, id: number): string {
  return Buffer.from(`010:${kind}${id}`, 'utf8').toString('base64');
}

export function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function makeUser(id: number, login: string, name: string, email: string): User {
  return Object.freeze({ id, nodeId: nodeId('User', id), login, name, email });
}

export class Store {
  readonly viewer: User;
  private readonly repos: Map<string, Repo> = new Map();
  private repoOrder: Repo[] = [];
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextCommentId = 1;
  private nextLabelId = 1;
  private nextSeq = 1;

  constructor() {
    this.viewer = makeUser(TOKEN_USER_ID, TOKEN_LOGIN, TOKEN_USER_NAME, TOKEN_USER_EMAIL);
  }

  /** A new sequence number used to break timestamp ties deterministically. */
  takeSeq(): number {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    return seq;
  }

  private repoKey(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  findRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  requireRepo(owner: string, name: string): Repo | undefined {
    const repo = this.findRepo(owner, name);
    if (repo === undefined) return undefined;
    if (repo.owner.login.toLowerCase() !== this.viewer.login.toLowerCase()) return undefined;
    return repo;
  }

  renameRepoKey(repo: Repo, oldName: string): void {
    this.repos.delete(this.repoKey(repo.owner.login, oldName));
    this.repos.set(this.repoKey(repo.owner.login, repo.name), repo);
  }

  createRepo(name: string, options: { description?: string | null; private?: boolean; defaultBranch?: string } = {}): Repo {
    const now = Date.now();
    const id = this.nextRepoId;
    this.nextRepoId += 1;
    const branch = options.defaultBranch !== undefined && options.defaultBranch !== '' ? options.defaultBranch : 'main';
    const repo: Repo = {
      id,
      nodeId: nodeId('Repository', id),
      seq: this.takeSeq(),
      name,
      owner: this.viewer,
      description: options.description === undefined ? null : options.description,
      private: options.private === true,
      defaultBranch: branch,
      createdAt: now,
      updatedAt: now,
      pushedAt: now,
      objects: new Map<string, GitObject>(),
      refs: new Map<string, string>(),
      labels: new Map<string, Label>(),
      issues: new Map<number, Issue>(),
      pulls: new Map<number, Pull>(),
      nextNumber: 1,
    };
    this.repos.set(this.repoKey(this.viewer.login, name), repo);
    this.repoOrder.push(repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner.login, repo.name));
    this.repoOrder = this.repoOrder.filter((entry) => entry !== repo);
  }

  listRepos(options: { sort?: string; direction?: string } = {}): Repo[] {
    const repos = [...this.repoOrder];
    const direction = options.direction === 'asc' ? 1 : -1;
    const sort = options.sort ?? 'full_name';
    repos.sort((a, b) => {
      if (sort === 'created') return (a.createdAt - b.createdAt || a.id - b.id) * direction;
      if (sort === 'updated' || sort === 'pushed') return (a.updatedAt - b.updatedAt || a.id - b.id) * direction;
      return a.name.toLowerCase() < b.name.toLowerCase() ? -1 * direction : a.name.toLowerCase() > b.name.toLowerCase() ? direction : 0;
    });
    return repos;
  }

  takeNumber(repo: Repo): number {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    return number;
  }

  createLabel(repo: Repo, input: { name: string; color?: string; description?: string }): Label | undefined {
    const key = input.name.toLowerCase();
    if (repo.labels.has(key)) return undefined;
    const label: Label = {
      id: this.nextLabelId,
      nodeId: nodeId('Label', this.nextLabelId),
      name: input.name,
      color: (input.color ?? 'ededed').replace(/^#/, '').toLowerCase(),
      description: input.description ?? '',
      default: false,
    };
    this.nextLabelId += 1;
    repo.labels.set(key, label);
    return label;
  }

  findLabel(repo: Repo, name: string): Label | undefined {
    return repo.labels.get(name.toLowerCase());
  }

  replaceLabel(repo: Repo, name: string, input: { newName?: string; color?: string; description?: string }): Label | undefined {
    const existing = this.findLabel(repo, name);
    if (existing === undefined) return undefined;
    repo.labels.delete(name.toLowerCase());
    const label: Label = {
      id: existing.id,
      nodeId: existing.nodeId,
      name: input.newName ?? existing.name,
      color: input.color === undefined ? existing.color : input.color.replace(/^#/, '').toLowerCase(),
      description: input.description ?? existing.description,
      default: existing.default,
    };
    repo.labels.set(label.name.toLowerCase(), label);
    return label;
  }

  deleteLabel(repo: Repo, name: string): boolean {
    return repo.labels.delete(name.toLowerCase());
  }

  createIssue(repo: Repo, input: { title: string; body: string; labels: string[] }): Issue {
    const now = Date.now();
    const id = this.nextIssueId;
    this.nextIssueId += 1;
    const issue: Issue = {
      id,
      nodeId: nodeId('Issue', id),
      seq: this.takeSeq(),
      number: this.takeNumber(repo),
      title: input.title,
      body: input.body,
      state: 'open',
      labels: [...input.labels],
      user: this.viewer,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      comments: [],
    };
    repo.issues.set(issue.number, issue);
    repo.updatedAt = now;
    return issue;
  }

  createComment(repo: Repo, issue: Issue, body: string): Comment {
    const now = Date.now();
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    const comment: Comment = {
      id,
      nodeId: nodeId('IssueComment', id),
      body,
      user: this.viewer,
      createdAt: now,
      updatedAt: now,
    };
    issue.comments.push(comment);
    issue.updatedAt = now;
    repo.updatedAt = now;
    return comment;
  }

  createPull(repo: Repo, input: { title: string; body: string; headRef: string; baseRef: string; headSha: string; baseSha: string }): Pull {
    const now = Date.now();
    const id = this.nextPullId;
    this.nextPullId += 1;
    const pull: Pull = {
      id,
      nodeId: nodeId('PullRequest', id),
      seq: this.takeSeq(),
      number: this.takeNumber(repo),
      title: input.title,
      body: input.body,
      state: 'open',
      headRef: input.headRef,
      baseRef: input.baseRef,
      headShaAtCreate: input.headSha,
      baseShaAtCreate: input.baseSha,
      user: this.viewer,
      createdAt: now,
      updatedAt: now,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
    };
    repo.pulls.set(pull.number, pull);
    repo.updatedAt = now;
    return pull;
  }

  /** A ref name as stored, or null when it names no commit. Tags are peeled to their commit. */
  resolveCommit(repo: Repo, ref: string): string | null {
    const direct = this.resolveRefSha(repo, ref);
    if (direct === null) return null;
    let sha: string | null = direct;
    for (let depth = 0; sha !== null && depth < 8; depth += 1) {
      const object = repo.objects.get(sha);
      if (object === undefined) return null;
      if (object.type === 'commit') return sha;
      if (object.type !== 'tag') return null;
      try {
        sha = parseTag(object.content).object;
      } catch {
        return null;
      }
    }
    return null;
  }

  resolveRefSha(repo: Repo, ref: string): string | null {
    const wanted = ref === '' || ref === 'HEAD' ? `refs/heads/${repo.defaultBranch}` : ref;
    if (wanted.startsWith('refs/')) {
      return repo.refs.get(wanted) ?? null;
    }
    const head = repo.refs.get(`refs/heads/${wanted}`);
    if (head !== undefined) return head;
    const tag = repo.refs.get(`refs/tags/${wanted}`);
    if (tag !== undefined) return tag;
    if (/^[0-9a-f]{40}$/.test(wanted) && repo.objects.has(wanted)) return wanted;
    return null;
  }

  listBranches(repo: Repo): { name: string; sha: string }[] {
    const branches: { name: string; sha: string }[] = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    branches.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return branches;
  }

  /** Every commit reachable from `tip`, newest first (a depth-first walk over parents). */
  walkCommits(repo: Repo, tip: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const visit = (sha: string): void => {
      if (seen.has(sha) || !repo.objects.has(sha)) return;
      seen.add(sha);
      out.push(sha);
      for (const parent of commitParentsOf(repo.objects, sha)) visit(parent);
    };
    visit(tip);
    return out;
  }

  commitFiles(repo: Repo, commitSha: string): Map<string, Buffer> {
    const tree = commitTreeOf(repo.objects, commitSha);
    return tree === null ? new Map() : readTreeContents(repo.objects, tree);
  }

  /** The closest common ancestor of two commits, or null when they share none. */
  mergeBase(repo: Repo, left: string, right: string): string | null {
    const distances = (tip: string): Map<string, number> => {
      const found = new Map<string, number>();
      const queue: { sha: string; depth: number }[] = [{ sha: tip, depth: 0 }];
      while (queue.length > 0) {
        const item = queue.shift() as { sha: string; depth: number };
        if (found.has(item.sha)) continue;
        found.set(item.sha, item.depth);
        for (const parent of commitParentsOf(repo.objects, item.sha)) {
          if (!found.has(parent)) queue.push({ sha: parent, depth: item.depth + 1 });
        }
      }
      return found;
    };
    const leftDistances = distances(left);
    const rightDistances = distances(right);
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [sha, leftDepth] of leftDistances) {
      const rightDepth = rightDistances.get(sha);
      if (rightDepth === undefined) continue;
      const score = Math.max(leftDepth, rightDepth) * 1_000_000 + leftDepth + rightDepth;
      if (score < bestScore) {
        bestScore = score;
        best = sha;
      }
    }
    return best;
  }
}
