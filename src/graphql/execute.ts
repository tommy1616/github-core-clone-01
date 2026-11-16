// GraphQL execution against the forge's in-memory store: validation of every selected field,
// resolvers over the same objects REST serves, Relay-style connections and cursor pagination, the
// mutations, and the introspection data the gh feature probes read.

import { iso, type Comment, type Issue, type Label, type Pull, type Repo, type Store, type User } from '../store.ts';
import { diffTrees, isMergeable } from '../rest/diff.ts';
import { performMerge } from '../merge.ts';
import { parseCommit } from '../git/objects.ts';
import {
  argumentsToJs,
  parseDocument,
  valueToJs,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
  type SelectionNode,
  type SelectionSetNode,
  type SourceLocation,
} from './parser.ts';
import {
  allTypes,
  fieldOf,
  introspectionRef,
  introspectionType,
  typeSpec,
  type FieldSpec,
  type TypeRef,
} from './schema.ts';

export interface GraphQLErrorEntry {
  readonly message: string;
  readonly locations?: readonly SourceLocation[];
  readonly path?: readonly (string | number)[];
}

export interface ExecutionResult {
  readonly data?: unknown;
  readonly errors?: readonly GraphQLErrorEntry[];
}

type Wrapped = Record<string, unknown> & { __typename: string };

interface ExecutionContext {
  readonly store: Store;
  readonly origin: string;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly fragments: ReadonlyMap<string, FragmentDefinitionNode>;
}

class ExecutionError extends Error {
  readonly path: (string | number)[];

  constructor(message: string, path: (string | number)[]) {
    super(message);
    this.name = 'ExecutionError';
    this.path = path;
  }
}

function wrap(typeName: string, properties: Record<string, unknown> = {}): Wrapped {
  return { __typename: typeName, ...properties };
}

function wrapUser(user: User): Wrapped {
  return wrap('User', { _user: user });
}

function wrapRepo(repo: Repo): Wrapped {
  return wrap('Repository', { _repo: repo });
}

function wrapIssue(repo: Repo, issue: Issue): Wrapped {
  return wrap('Issue', { _repo: repo, _issue: issue });
}

function wrapPull(repo: Repo, pull: Pull): Wrapped {
  return wrap('PullRequest', { _repo: repo, _pull: pull });
}

function wrapComment(repo: Repo, issue: Issue, comment: Comment): Wrapped {
  return wrap('IssueComment', { _repo: repo, _issue: issue, _comment: comment });
}

function wrapLabel(repo: Repo, label: Label): Wrapped {
  return wrap('Label', { _repo: repo, _label: label });
}

function wrapRef(repo: Repo, name: string, sha: string | null, prefix?: string): Wrapped {
  return wrap('Ref', { _repo: repo, _name: name, _sha: sha, _prefix: prefix ?? (name.startsWith('refs/tags/') ? 'refs/tags' : 'refs/heads') });
}

function wrapCommit(repo: Repo, sha: string): Wrapped {
  return wrap('Commit', { _repo: repo, _sha: sha });
}

function wrapFile(file: { filename: string; status: string; additions: number; deletions: number }): Wrapped {
  return wrap('PullRequestChangedFile', { _file: file });
}

interface PageInfoValue {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

interface Paginated<T> {
  items: T[];
  cursors: string[];
  pageInfo: PageInfoValue;
  total: number;
}

function encodeCursor(index: number): string {
  return `cursor:${index}`;
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  const match = /^cursor:(\d+)$/.exec(cursor);
  if (match === null) return null;
  return Number(match[1]);
}

function numberArg(args: Readonly<Record<string, unknown>>, name: string): number | null {
  const value = args[name];
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function stringArg(args: Readonly<Record<string, unknown>>, name: string): string | null {
  const value = args[name];
  return typeof value === 'string' ? value : null;
}

function stringArrayArg(args: Readonly<Record<string, unknown>>, name: string): string[] | null {
  const value = args[name];
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function paginate<T>(items: readonly T[], args: Readonly<Record<string, unknown>>): Paginated<T> {
  const first = numberArg(args, 'first');
  const last = numberArg(args, 'last');
  const after = decodeCursor(args.after);
  const before = decodeCursor(args.before);
  let start = after === null ? 0 : Math.min(items.length, after + 1);
  let end = before === null ? items.length : Math.max(0, Math.min(items.length, before));
  if (last !== null && first === null) start = Math.max(start, end - Math.max(0, last));
  if (first !== null) end = Math.min(end, start + Math.max(0, first));
  if (end < start) end = start;
  const slice = items.slice(start, end);
  const cursors = slice.map((_, index) => encodeCursor(start + index));
  return {
    items: slice,
    cursors,
    total: items.length,
    pageInfo: {
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: cursors[0] ?? null,
      endCursor: cursors[cursors.length - 1] ?? null,
    },
  };
}

function connection(typeName: string, paginated: Paginated<Wrapped>, edgeType: string): Wrapped {
  return wrap(typeName, {
    _nodes: paginated.items,
    _cursors: paginated.cursors,
    _pageInfo: paginated.pageInfo,
    _total: paginated.total,
    _edgeType: edgeType,
  });
}

function issueStateOf(issue: Issue): string {
  return issue.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function pullStateOf(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function labelsOfIssue(repo: Repo, issue: Issue): Wrapped[] {
  const out: Wrapped[] = [];
  for (const name of issue.labels) {
    const label = repo.labels.get(name.toLowerCase());
    if (label !== undefined) out.push(wrapLabel(repo, label));
  }
  return out;
}

function pageInfoValue(value: unknown): Wrapped {
  const info = value as PageInfoValue;
  return wrap('PageInfo', {
    hasNextPage: info.hasNextPage,
    hasPreviousPage: info.hasPreviousPage,
    startCursor: info.startCursor,
    endCursor: info.endCursor,
  });
}

function typeMatches(actual: string, condition: string): boolean {
  if (actual === condition) return true;
  const spec = typeSpec(condition);
  return spec?.possibleTypes?.includes(actual) ?? false;
}

function directiveAllows(directives: readonly { name: string; arguments: readonly { name: string; value: unknown }[] }[], context: ExecutionContext): boolean {
  for (const directive of directives) {
    const args: Record<string, unknown> = {};
    for (const argument of directive.arguments) args[argument.name] = valueToJs(argument.value, context.variables);
    if (directive.name === 'skip' && args.if === true) return false;
    if (directive.name === 'include' && args.if === false) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Validation

function unwrapNamed(type: TypeRef): string | null {
  if (type.kind === 'named') return type.name;
  return unwrapNamed(type.ofType);
}

function validateSelectionSet(
  typeName: string,
  selectionSet: SelectionSetNode,
  document: DocumentNode,
  errors: GraphQLErrorEntry[],
  seenFragments: Set<string>,
): void {
  for (const selection of selectionSet.selections) {
    if (selection.kind === 'field') {
      if (selection.name === '__typename') continue;
      const field = fieldOf(typeName, selection.name);
      if (field === undefined) {
        errors.push({
          message: `Cannot query field "${selection.name}" on type "${typeName}".`,
          locations: [selection.loc],
          path: [selection.name],
        });
        continue;
      }
      if (selection.selectionSet !== undefined) {
        const target = unwrapNamed(field.type);
        if (target !== null) {
          const targetSpec = typeSpec(target);
          if (targetSpec !== undefined && (targetSpec.kind === 'OBJECT' || targetSpec.kind === 'INTERFACE' || targetSpec.kind === 'UNION')) {
            validateSelectionSet(target, selection.selectionSet, document, errors, seenFragments);
          }
        }
      }
      continue;
    }
    if (selection.kind === 'fragment_spread') {
      const fragment = document.fragments.get(selection.name);
      if (fragment === undefined) {
        errors.push({ message: `Unknown fragment "${selection.name}".`, locations: [selection.loc], path: [selection.name] });
        continue;
      }
      const key = `${fragment.typeCondition}:${fragment.name}`;
      if (seenFragments.has(key)) continue;
      seenFragments.add(key);
      validateSelectionSet(fragment.typeCondition, fragment.selectionSet, document, errors, seenFragments);
      continue;
    }
    const condition = selection.typeCondition ?? typeName;
    validateSelectionSet(condition, selection.selectionSet, document, errors, seenFragments);
  }
}

// ---------------------------------------------------------------------------------------------
// Field collection and execution

interface CollectedField {
  readonly responseKey: string;
  readonly nodes: FieldNode[];
}

function collectFields(
  actualType: string,
  selectionSet: SelectionSetNode,
  context: ExecutionContext,
  output: Map<string, CollectedField>,
  seenFragments: Set<string>,
): void {
  for (const selection of selectionSet.selections) {
    if (!directiveAllows(selection.directives, context)) continue;
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      const existing = output.get(key);
      if (existing === undefined) output.set(key, { responseKey: key, nodes: [selection] });
      else existing.nodes.push(selection);
      continue;
    }
    if (selection.kind === 'fragment_spread') {
      const fragment = context.fragments.get(selection.name);
      if (fragment === undefined) continue;
      if (!typeMatches(actualType, fragment.typeCondition)) continue;
      const key = `${fragment.typeCondition}:${fragment.name}`;
      if (seenFragments.has(key)) continue;
      seenFragments.add(key);
      collectFields(actualType, fragment.selectionSet, context, output, seenFragments);
      continue;
    }
    const condition = selection.typeCondition ?? actualType;
    if (selection.typeCondition !== undefined && !typeMatches(actualType, condition)) continue;
    collectFields(actualType, selection.selectionSet, context, output, seenFragments);
  }
}

function mergedSelection(field: CollectedField): SelectionSetNode | undefined {
  const sets = field.nodes.map((node) => node.selectionSet).filter((set): set is SelectionSetNode => set !== undefined);
  if (sets.length === 0) return undefined;
  if (sets.length === 1) return sets[0];
  return { selections: sets.flatMap((set) => set.selections) };
}

function completeValue(
  raw: unknown,
  selectionSet: SelectionSetNode,
  context: ExecutionContext,
  path: (string | number)[],
): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) {
    return raw.map((item, index) => completeValue(item, selectionSet, context, [...path, index]));
  }
  if (typeof raw !== 'object') return raw;
  const wrapped = raw as Wrapped;
  const runtime = typeof wrapped.__typename === 'string' ? wrapped.__typename : 'Unknown';
  return executeSelectionSet(runtime, wrapped, selectionSet, context, path);
}

function executeSelectionSet(
  typeName: string,
  value: Record<string, unknown>,
  selectionSet: SelectionSetNode,
  context: ExecutionContext,
  path: (string | number)[],
): Record<string, unknown> {
  const collected = new Map<string, CollectedField>();
  collectFields(typeName, selectionSet, context, collected, new Set());
  const out: Record<string, unknown> = {};
  for (const field of collected.values()) {
    const node = field.nodes[0] as FieldNode;
    if (node.name === '__typename') {
      out[field.responseKey] = typeName;
      continue;
    }
    const args = argumentsToJs(node.arguments, context.variables);
    let raw: unknown;
    try {
      raw = resolveField(typeName, node.name, value, args, context);
    } catch (err) {
      throw new ExecutionError(err instanceof Error ? err.message : String(err), [...path, field.responseKey]);
    }
    const selection = mergedSelection(field);
    out[field.responseKey] = selection === undefined ? raw : completeValue(raw, selection, context, [...path, field.responseKey]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Lookups and resolvers

function findRepoByNodeId(store: Store, id: string): Repo | null {
  for (const repo of store.listRepos()) if (repo.nodeId === id) return repo;
  return null;
}

function findIssueByNodeId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  for (const repo of store.listRepos()) {
    for (const issue of repo.issues.values()) if (issue.nodeId === id) return { repo, issue };
  }
  return null;
}

function findPullByNodeId(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  for (const repo of store.listRepos()) {
    for (const pull of repo.pulls.values()) if (pull.nodeId === id) return { repo, pull };
  }
  return null;
}

function findNode(store: Store, id: string): Wrapped | null {
  if (store.viewer.nodeId === id) return wrapUser(store.viewer);
  for (const repo of store.listRepos()) {
    if (repo.nodeId === id) return wrapRepo(repo);
    for (const issue of repo.issues.values()) if (issue.nodeId === id) return wrapIssue(repo, issue);
    for (const pull of repo.pulls.values()) if (pull.nodeId === id) return wrapPull(repo, pull);
    for (const issue of repo.issues.values()) {
      for (const comment of issue.comments) if (comment.nodeId === id) return wrapComment(repo, issue, comment);
    }
    for (const label of repo.labels.values()) if (label.nodeId === id) return wrapLabel(repo, label);
  }
  return null;
}

function issueOrderComparator(field: string, direction: string): (a: Issue, b: Issue) => number {
  const sign = direction === 'ASC' ? 1 : -1;
  return (a: Issue, b: Issue): number => {
    if (field === 'UPDATED_AT') return (a.updatedAt - b.updatedAt || a.number - b.number) * sign;
    if (field === 'COMMENTS') return (a.comments.length - b.comments.length || a.number - b.number) * sign;
    return (a.number - b.number) * sign;
  };
}

function pullRequestMergeable(store: Store, repo: Repo, pull: Pull): string {
  if (pull.merged) return 'UNKNOWN';
  const mergeable = isMergeable(store, repo, pull.headRef, pull.baseRef);
  if (mergeable === true) return 'MERGEABLE';
  if (mergeable === false) return 'CONFLICTING';
  return 'UNKNOWN';
}

function pullFileList(store: Store, repo: Repo, pull: Pull): Wrapped[] {
  const head = store.resolveCommit(repo, pull.headRef);
  const base = store.resolveCommit(repo, pull.baseRef);
  if (head === null || base === null) return [];
  const mergeBase = store.mergeBase(repo, head, base);
  return diffTrees(repo, base, head, mergeBase).map((file) => wrapFile(file));
}

function resolveField(
  typeName: string,
  fieldName: string,
  value: Record<string, unknown>,
  args: Record<string, unknown>,
  context: ExecutionContext,
): unknown {
  const store = context.store;
  switch (typeName) {
    case 'Query': {
      if (fieldName === 'viewer') return wrapUser(store.viewer);
      if (fieldName === 'user') {
        const login = stringArg(args, 'login');
        return login !== null && login.toLowerCase() === store.viewer.login.toLowerCase() ? wrapUser(store.viewer) : null;
      }
      if (fieldName === 'repository') {
        const owner = stringArg(args, 'owner');
        const name = stringArg(args, 'name');
        if (owner === null || name === null) return null;
        const repo = store.findRepo(owner, name);
        if (repo === undefined || repo.owner.login.toLowerCase() !== store.viewer.login.toLowerCase()) return null;
        return wrapRepo(repo);
      }
      if (fieldName === 'node') {
        const id = stringArg(args, 'id');
        return id === null ? null : findNode(store, id);
      }
      if (fieldName === 'nodes') {
        const ids = stringArrayArg(args, 'ids') ?? [];
        return ids.map((id) => findNode(store, id));
      }
      if (fieldName === '__type') {
        const name = stringArg(args, 'name');
        return name === null ? null : introspectionType(name);
      }
      if (fieldName === '__schema') return wrap('__Schema');
      return null;
    }
    case 'Mutation':
      return resolveMutation(fieldName, args, context);
    case 'Repository': {
      const repo = value._repo as Repo;
      if (fieldName === 'id') return repo.nodeId;
      if (fieldName === 'databaseId') return repo.id;
      if (fieldName === 'name') return repo.name;
      if (fieldName === 'nameWithOwner') return `${repo.owner.login}/${repo.name}`;
      if (fieldName === 'description') return repo.description;
      if (fieldName === 'owner') return wrapUser(repo.owner);
      if (fieldName === 'defaultBranchRef') {
        const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
        return sha === null ? null : wrapRef(repo, repo.defaultBranch, sha);
      }
      if (fieldName === 'viewerPermission') return 'ADMIN';
      if (fieldName === 'hasIssuesEnabled') return true;
      if (fieldName === 'isPrivate') return repo.private;
      if (fieldName === 'createdAt') return iso(repo.createdAt);
      if (fieldName === 'updatedAt') return iso(repo.updatedAt);
      if (fieldName === 'url') return `${context.origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}`;
      if (fieldName === 'sshUrl') return `git@${context.origin.replace(/^https?:\/\//, '')}:${repo.owner.login}/${repo.name}.git`;
      if (fieldName === 'issue') {
        const number = numberArg(args, 'number');
        if (number === null) return null;
        const issue = repo.issues.get(number);
        return issue === undefined ? null : wrapIssue(repo, issue);
      }
      if (fieldName === 'issues') {
        let issues = [...repo.issues.values()];
        const states = stringArrayArg(args, 'states');
        if (states !== null && states.length > 0) {
          issues = issues.filter((issue) => states.includes(issueStateOf(issue)));
        }
        const labels = stringArrayArg(args, 'labels');
        if (labels !== null && labels.length > 0) {
          issues = issues.filter((issue) => labels.every((name) => issue.labels.some((label) => label.toLowerCase() === name.toLowerCase())));
        }
        const orderBy = args.orderBy;
        const order = typeof orderBy === 'object' && orderBy !== null ? (orderBy as Record<string, unknown>) : {};
        const field = typeof order.field === 'string' ? order.field : 'CREATED_AT';
        const direction = typeof order.direction === 'string' ? order.direction : 'DESC';
        issues.sort(issueOrderComparator(field, direction));
        const page = paginate(issues, args);
        return connection('IssueConnection', { ...page, items: page.items.map((issue) => wrapIssue(repo, issue)) }, 'IssueEdge');
      }
      if (fieldName === 'pullRequest') {
        const number = numberArg(args, 'number');
        if (number === null) return null;
        const pull = repo.pulls.get(number);
        return pull === undefined ? null : wrapPull(repo, pull);
      }
      if (fieldName === 'pullRequests') {
        let pulls = [...repo.pulls.values()];
        const states = stringArrayArg(args, 'states');
        if (states !== null && states.length > 0) pulls = pulls.filter((pull) => states.includes(pullStateOf(pull)));
        const headRefName = stringArg(args, 'headRefName');
        if (headRefName !== null) pulls = pulls.filter((pull) => pull.headRef === headRefName);
        const baseRefName = stringArg(args, 'baseRefName');
        if (baseRefName !== null) pulls = pulls.filter((pull) => pull.baseRef === baseRefName);
        pulls.sort((a, b) => b.number - a.number);
        const page = paginate(pulls, args);
        return connection('PullRequestConnection', { ...page, items: page.items.map((pull) => wrapPull(repo, pull)) }, 'PullRequestEdge');
      }
      if (fieldName === 'labels') {
        const labels = [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        const page = paginate(labels, args);
        return connection('LabelConnection', { ...page, items: page.items.map((label) => wrapLabel(repo, label)) }, 'LabelEdge');
      }
      if (fieldName === 'ref') {
        const qualified = stringArg(args, 'qualifiedName');
        if (qualified === null) return null;
        const ref = qualified.startsWith('refs/') ? qualified : `refs/heads/${qualified}`;
        const sha = repo.refs.get(ref);
        return sha === undefined ? null : wrapRef(repo, ref.slice('refs/'.length), sha, ref.startsWith('refs/tags/') ? 'refs/tags' : 'refs/heads');
      }
      return null;
    }
    case 'Issue': {
      const repo = value._repo as Repo;
      const issue = value._issue as Issue;
      if (fieldName === 'id') return issue.nodeId;
      if (fieldName === 'number') return issue.number;
      if (fieldName === 'title') return issue.title;
      if (fieldName === 'state') return issueStateOf(issue);
      if (fieldName === 'stateReason') return issue.state === 'closed' ? 'COMPLETED' : null;
      if (fieldName === 'body' || fieldName === 'bodyText') return issue.body;
      if (fieldName === 'createdAt') return iso(issue.createdAt);
      if (fieldName === 'updatedAt') return iso(issue.updatedAt);
      if (fieldName === 'closedAt') return issue.closedAt === null ? null : iso(issue.closedAt);
      if (fieldName === 'author') return wrapUser(issue.user);
      if (fieldName === 'editor') return null;
      if (fieldName === 'repository') return wrapRepo(repo);
      if (fieldName === 'labels') return labelsOfIssue(repo, issue);
      if (fieldName === 'comments') return issue.comments.map((comment) => wrapComment(repo, issue, comment));
      if (fieldName === 'url') {
        return `${context.origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/issues/${issue.number}`;
      }
      if (fieldName === 'locked') return false;
      if (fieldName === 'isPinned') return false;
      return null;
    }
    case 'PullRequest': {
      const repo = value._repo as Repo;
      const pull = value._pull as Pull;
      if (fieldName === 'id') return pull.nodeId;
      if (fieldName === 'number') return pull.number;
      if (fieldName === 'state') return pullStateOf(pull);
      if (fieldName === 'merged') return pull.merged;
      if (fieldName === 'mergedAt') return pull.mergedAt === null ? null : iso(pull.mergedAt);
      if (fieldName === 'closedAt') return pull.mergedAt === null ? null : iso(pull.mergedAt);
      if (fieldName === 'createdAt') return iso(pull.createdAt);
      if (fieldName === 'updatedAt') return iso(pull.updatedAt);
      if (fieldName === 'title') return pull.title;
      if (fieldName === 'body') return pull.body;
      if (fieldName === 'headRefName') return pull.headRef;
      if (fieldName === 'baseRefName') return pull.baseRef;
      if (fieldName === 'mergeable') return pullRequestMergeable(store, repo, pull);
      if (fieldName === 'mergeStateStatus') {
        const mergeable = pullRequestMergeable(store, repo, pull);
        return mergeable === 'MERGEABLE' ? 'CLEAN' : mergeable === 'CONFLICTING' ? 'DIRTY' : 'UNKNOWN';
      }
      if (fieldName === 'isDraft') return false;
      if (fieldName === 'author') return wrapUser(pull.user);
      if (fieldName === 'editor') return null;
      if (fieldName === 'repository') return wrapRepo(repo);
      if (fieldName === 'baseRef') {
        const sha = store.resolveCommit(repo, pull.baseRef);
        return wrapRef(repo, pull.baseRef, sha);
      }
      if (fieldName === 'headRef') {
        const sha = store.resolveCommit(repo, pull.headRef);
        return wrapRef(repo, pull.headRef, sha);
      }
      if (fieldName === 'mergeCommit') return pull.mergeCommitSha === null ? null : wrapCommit(repo, pull.mergeCommitSha);
      if (fieldName === 'files') {
        const page = paginate(pullFileList(store, repo, pull), args);
        return connection('PullRequestChangedFileConnection', page, 'PullRequestChangedFileEdge');
      }
      if (fieldName === 'additions' || fieldName === 'deletions' || fieldName === 'changedFiles') {
        const files = pullFileList(store, repo, pull);
        if (fieldName === 'additions') return files.reduce((total, file) => total + ((file._file as { additions: number }).additions), 0);
        if (fieldName === 'deletions') return files.reduce((total, file) => total + ((file._file as { deletions: number }).deletions), 0);
        return files.length;
      }
      if (fieldName === 'url') {
        return `${context.origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/pull/${pull.number}`;
      }
      return null;
    }
    case 'IssueComment': {
      const repo = value._repo as Repo;
      const issue = value._issue as Issue;
      const comment = value._comment as Comment;
      if (fieldName === 'id') return comment.nodeId;
      if (fieldName === 'body' || fieldName === 'bodyText') return comment.body;
      if (fieldName === 'author') return wrapUser(comment.user);
      if (fieldName === 'createdAt') return iso(comment.createdAt);
      if (fieldName === 'updatedAt') return iso(comment.updatedAt);
      if (fieldName === 'url') return `${context.origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/issues/${issue.number}#issuecomment-${comment.id}`;
      if (fieldName === 'isMinimized') return false;
      if (fieldName === 'issue') return wrapIssue(repo, issue);
      if (fieldName === 'pullRequest') return null;
      return null;
    }
    case 'User': {
      const user = value._user as User;
      if (fieldName === 'id') return user.nodeId;
      if (fieldName === 'databaseId') return user.id;
      if (fieldName === 'login') return user.login;
      if (fieldName === 'name') return user.name;
      if (fieldName === 'email') return user.email;
      if (fieldName === 'avatarUrl') return `${context.origin}/avatars/u/${user.id}`;
      if (fieldName === 'url') return `${context.origin}/${encodeURIComponent(user.login)}`;
      if (fieldName === 'bio' || fieldName === 'company' || fieldName === 'createdAt') return null;
      if (fieldName === 'isViewer') return user.id === store.viewer.id;
      if (fieldName === 'isSiteAdmin') return false;
      return null;
    }
    case 'Label': {
      const label = value._label as Label;
      if (fieldName === 'id') return label.nodeId;
      if (fieldName === 'name') return label.name;
      if (fieldName === 'color') return label.color;
      if (fieldName === 'description') return label.description;
      if (fieldName === 'isDefault') return label.default;
      return null;
    }
    case 'Ref': {
      const repo = value._repo as Repo;
      const name = value._name as string;
      const sha = value._sha as string | null;
      if (fieldName === 'id') return Buffer.from(`010:Ref${name}`, 'utf8').toString('base64');
      if (fieldName === 'name') return name;
      if (fieldName === 'prefix') return value._prefix;
      if (fieldName === 'target') return sha === null ? null : wrapCommit(repo, sha);
      if (fieldName === 'repository') return wrapRepo(repo);
      return null;
    }
    case 'Commit': {
      const repo = value._repo as Repo;
      const sha = value._sha as string;
      const object = repo.objects.get(sha);
      let message = '';
      let date = iso(0);
      if (object !== undefined && object.type === 'commit') {
        try {
          const parsed = parseCommit(object.content);
          message = parsed.message;
          const match = /^.* (\d+) [+-]\d{4}$/.exec(parsed.committer);
          if (match !== null) date = iso(Number(match[1]) * 1000);
        } catch {
          // Keep the empty message.
        }
      }
      if (fieldName === 'id') return Buffer.from(`010:Commit${sha}`, 'utf8').toString('base64');
      if (fieldName === 'oid') return sha;
      if (fieldName === 'abbreviatedOid') return sha.slice(0, 7);
      if (fieldName === 'message') return message;
      if (fieldName === 'messageHeadline') return message.split('\n')[0] ?? '';
      if (fieldName === 'committedDate' || fieldName === 'authoredDate') return date;
      if (fieldName === 'author' || fieldName === 'committer') return wrapUser(repo.owner);
      if (fieldName === 'tree') {
        const object2 = repo.objects.get(sha);
        const treeSha = object2 !== undefined && object2.type === 'commit' ? commitTree(repo, sha) : null;
        return treeSha === null ? null : wrap('Tree', { _repo: repo, _sha: treeSha });
      }
      if (fieldName === 'url') return `${context.origin}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/commit/${sha}`;
      return null;
    }
    case 'PullRequestChangedFile': {
      const file = value._file as { filename: string; status: string; additions: number; deletions: number };
      if (fieldName === 'path') return file.filename;
      if (fieldName === 'additions') return file.additions;
      if (fieldName === 'deletions') return file.deletions;
      if (fieldName === 'changeType') return file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED';
      if (fieldName === 'viewerViewedState') return 'UNVIEWED';
      return null;
    }
    case 'PageInfo':
      return value[fieldName] ?? null;
    case '__Schema': {
      if (fieldName === 'description') return null;
      if (fieldName === 'types') return allTypes().map((spec) => introspectionType(spec.name));
      if (fieldName === 'queryType') return introspectionType('Query');
      if (fieldName === 'mutationType') return introspectionType('Mutation');
      if (fieldName === 'subscriptionType') return null;
      if (fieldName === 'directives') return [];
      return null;
    }
    case '__Type': {
      if (fieldName === 'kind') return value.kind;
      if (fieldName === 'name') return value.name;
      if (fieldName === 'description') return value.description ?? null;
      if (fieldName === 'specifiedByURL') return null;
      if (fieldName === 'fields') {
        const fields = value.fields as FieldSpec[] | null;
        return fields === null ? null : fields.map((field) => wrap('__Field', { _field: field }));
      }
      if (fieldName === 'enumValues') {
        const values = value.enumValues as { name: string; description?: string }[] | null;
        return values === null ? null : values.map((entry) => wrap('__EnumValue', { _enum: entry }));
      }
      if (fieldName === 'inputFields') {
        const fields = value.inputFields as { name: string; type: TypeRef; description?: string; defaultValue?: string }[] | null;
        return fields === null ? null : fields.map((entry) => wrap('__InputValue', { _input: entry }));
      }
      if (fieldName === 'interfaces') return ((value.interfaces as string[] | undefined) ?? []).map((name) => introspectionType(name));
      if (fieldName === 'possibleTypes') return ((value.possibleTypes as string[] | undefined) ?? []).map((name) => introspectionType(name));
      if (fieldName === 'ofType') return value.ofType ?? null;
      return null;
    }
    case '__Field': {
      const field = value._field as FieldSpec;
      if (fieldName === 'name') return field.name;
      if (fieldName === 'description') return field.description ?? null;
      if (fieldName === 'args') return (field.args ?? []).map((arg) => wrap('__InputValue', { _input: arg }));
      if (fieldName === 'type') return wrap('__Type', introspectionRef(field.type));
      if (fieldName === 'isDeprecated') return field.deprecated === true;
      if (fieldName === 'deprecationReason') return field.deprecationReason ?? null;
      return null;
    }
    case '__InputValue': {
      const input = value._input as { name: string; type: TypeRef; description?: string; defaultValue?: string };
      if (fieldName === 'name') return input.name;
      if (fieldName === 'description') return input.description ?? null;
      if (fieldName === 'type') return wrap('__Type', introspectionRef(input.type));
      if (fieldName === 'defaultValue') return input.defaultValue ?? null;
      if (fieldName === 'isDeprecated') return false;
      if (fieldName === 'deprecationReason') return null;
      return null;
    }
    case '__EnumValue': {
      const entry = value._enum as { name: string; description?: string; deprecated?: boolean; deprecationReason?: string };
      if (fieldName === 'name') return entry.name;
      if (fieldName === 'description') return entry.description ?? null;
      if (fieldName === 'isDeprecated') return entry.deprecated === true;
      if (fieldName === 'deprecationReason') return entry.deprecationReason ?? null;
      return null;
    }
    case '__Directive':
      if (fieldName === 'name') return value.name;
      if (fieldName === 'description') return null;
      if (fieldName === 'isRepeatable') return false;
      if (fieldName === 'locations') return [];
      if (fieldName === 'args') return [];
      return null;
    default:
      break;
  }

  if (typeName.endsWith('Connection')) {
    if (fieldName === 'nodes') return value._nodes;
    if (fieldName === 'edges') {
      const nodes = value._nodes as Wrapped[];
      const cursors = value._cursors as string[];
      const edgeType = value._edgeType as string;
      return nodes.map((node, index) => wrap(edgeType, { _node: node, _cursor: cursors[index] ?? encodeCursor(index) }));
    }
    if (fieldName === 'pageInfo') return pageInfoValue(value._pageInfo);
    if (fieldName === 'totalCount') return value._total;
  }
  if (typeName.endsWith('Edge')) {
    if (fieldName === 'node') return value._node;
    if (fieldName === 'cursor') return value._cursor;
  }
  if (typeName.endsWith('Payload')) {
    if (fieldName === 'clientMutationId') return value._clientMutationId ?? null;
    if (fieldName === 'issue') return value._issue ?? null;
    if (fieldName === 'pullRequest') return value._pullRequest ?? null;
    if (fieldName === 'commentEdge') return value._commentEdge ?? null;
  }
  return null;
}

function commitTree(repo: Repo, sha: string): string | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const match = /^tree ([0-9a-f]{40})$/m.exec(object.content.toString('utf8'));
  return match === null ? null : (match[1] as string);
}

function resolveMutation(fieldName: string, args: Record<string, unknown>, context: ExecutionContext): unknown {
  const store = context.store;
  const input = typeof args.input === 'object' && args.input !== null ? (args.input as Record<string, unknown>) : {};
  const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;

  if (fieldName === 'createIssue') {
    const repoId = stringArg(input, 'repositoryId');
    const repo = repoId === null ? null : findRepoByNodeId(store, repoId);
    if (repo === null) throw new Error('Repository not found');
    const title = stringArg(input, 'title') ?? '';
    const body = stringArg(input, 'body') ?? '';
    const issue = store.createIssue(repo, { title, body, labels: [] });
    const labelIds = stringArrayArg(input, 'labelIds') ?? [];
    for (const id of labelIds) {
      for (const label of repo.labels.values()) {
        if (label.nodeId === id && !issue.labels.includes(label.name)) issue.labels.push(label.name);
      }
    }
    if (labelIds.length > 0) issue.version += 1;
    return wrap('CreateIssuePayload', { _issue: wrapIssue(repo, issue), _clientMutationId: clientMutationId });
  }

  if (fieldName === 'closeIssue' || fieldName === 'reopenIssue' || fieldName === 'updateIssue') {
    const id = stringArg(input, fieldName === 'updateIssue' ? 'id' : 'issueId');
    const found = id === null ? null : findIssueByNodeId(store, id);
    if (found === null) throw new Error('Issue not found');
    const { repo, issue } = found;
    if (fieldName === 'closeIssue') {
      issue.state = 'closed';
      issue.closedAt = Date.now();
    } else if (fieldName === 'reopenIssue') {
      issue.state = 'open';
      issue.closedAt = null;
    } else {
      const title = stringArg(input, 'title');
      if (title !== null) issue.title = title;
      if ('body' in input) issue.body = stringArg(input, 'body') ?? '';
      const state = stringArg(input, 'state');
      if (state === 'OPEN' || state === 'CLOSED') {
        issue.state = state === 'CLOSED' ? 'closed' : 'open';
        issue.closedAt = issue.state === 'closed' ? Date.now() : null;
      }
      const labels = stringArrayArg(input, 'labels');
      if (labels !== null) issue.labels = labels;
    }
    issue.updatedAt = Date.now();
    issue.version += 1;
    repo.updatedAt = issue.updatedAt;
    const payloadName = fieldName === 'closeIssue' ? 'CloseIssuePayload' : fieldName === 'reopenIssue' ? 'ReopenIssuePayload' : 'UpdateIssuePayload';
    return wrap(payloadName, { _issue: wrapIssue(repo, issue), _clientMutationId: clientMutationId });
  }

  if (fieldName === 'addComment') {
    const subjectId = stringArg(input, 'subjectId');
    const body = stringArg(input, 'body') ?? '';
    const found = subjectId === null ? null : findIssueByNodeId(store, subjectId);
    if (found === null) throw new Error('Comment subject not found');
    const comment = store.createComment(found.repo, found.issue, body);
    return wrap('AddCommentPayload', {
      _commentEdge: wrap('IssueCommentEdge', { _node: wrapComment(found.repo, found.issue, comment), _cursor: encodeCursor(comment.id) }),
      _clientMutationId: clientMutationId,
    });
  }

  if (fieldName === 'createPullRequest') {
    const repoId = stringArg(input, 'repositoryId');
    const repo = repoId === null ? null : findRepoByNodeId(store, repoId);
    if (repo === null) throw new Error('Repository not found');
    const headRef = stringArg(input, 'headRefName');
    const baseRef = stringArg(input, 'baseRefName') ?? repo.defaultBranch;
    if (headRef === null) throw new Error('headRefName is required');
    const headSha = store.resolveCommit(repo, headRef);
    const baseSha = store.resolveCommit(repo, baseRef);
    if (headSha === null) throw new Error(`No commit found for ${headRef}`);
    if (baseSha === null) throw new Error(`No commit found for ${baseRef}`);
    const pull = store.createPull(repo, {
      title: stringArg(input, 'title') ?? '',
      body: stringArg(input, 'body') ?? '',
      headRef,
      baseRef,
      headSha,
      baseSha,
    });
    return wrap('CreatePullRequestPayload', { _pullRequest: wrapPull(repo, pull), _clientMutationId: clientMutationId });
  }

  if (fieldName === 'mergePullRequest') {
    const pullId = stringArg(input, 'pullRequestId');
    const found = pullId === null ? null : findPullByNodeId(store, pullId);
    if (found === null) throw new Error('Pull request not found');
    const outcome = performMerge(store, found.repo, found.pull);
    if (!outcome.ok) throw new Error('Pull request is not mergeable');
    return wrap('MergePullRequestPayload', { _pullRequest: wrapPull(found.repo, found.pull), _clientMutationId: clientMutationId });
  }

  return null;
}

// ---------------------------------------------------------------------------------------------
// Operation selection and the public entry point

function coerceVariables(operation: OperationDefinitionNode, provided: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const variables: Record<string, unknown> = { ...provided };
  for (const definition of operation.variableDefinitions) {
    if (variables[definition.name] === undefined && definition.defaultValue !== undefined) {
      variables[definition.name] = valueToJs(definition.defaultValue, variables);
    }
  }
  return variables;
}

function chooseOperation(document: DocumentNode, operationName: string | null): OperationDefinitionNode | GraphQLErrorEntry {
  if (operationName !== null) {
    const named = document.operations.find((operation) => operation.name === operationName);
    if (named !== undefined) return named;
    return { message: `Unknown operation named "${operationName}".` };
  }
  if (document.operations.length === 1) return document.operations[0] as OperationDefinitionNode;
  if (document.operations.length === 0) return { message: 'The document contains no operation.' };
  return { message: 'Must provide operation name if query contains multiple operations.' };
}

export function executeGraphQL(
  store: Store,
  origin: string,
  query: string,
  variables: Readonly<Record<string, unknown>> = {},
  operationName: string | null = null,
): ExecutionResult {
  let document: DocumentNode;
  try {
    document = parseDocument(query);
  } catch (err) {
    const locations = err instanceof Error && 'locations' in err ? ((err as { locations?: SourceLocation[] }).locations ?? undefined) : undefined;
    return { errors: [{ message: err instanceof Error ? err.message : String(err), ...(locations === undefined ? {} : { locations }) }] };
  }
  const operation = chooseOperation(document, operationName);
  if ('message' in operation) return { errors: [operation] };

  const errors: GraphQLErrorEntry[] = [];
  validateSelectionSet(operation.operation === 'mutation' ? 'Mutation' : 'Query', operation.selectionSet, document, errors, new Set());
  if (errors.length > 0) return { data: null, errors };

  const context: ExecutionContext = {
    store,
    origin,
    variables: coerceVariables(operation, variables),
    fragments: document.fragments,
  };
  try {
    const data = executeSelectionSet(
      operation.operation === 'mutation' ? 'Mutation' : 'Query',
      { __typename: operation.operation === 'mutation' ? 'Mutation' : 'Query' },
      operation.selectionSet,
      context,
      [],
    );
    return { data };
  } catch (err) {
    if (err instanceof ExecutionError) {
      return { data: null, errors: [{ message: err.message, path: err.path }] };
    }
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

