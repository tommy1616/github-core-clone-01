// The GraphQL v4 schema: one description used for validation, execution and introspection. Type
// references are kept as a small named/list/non-null tree so __type can render kind, name and ofType
// exactly the way a GraphQL client expects.

export type TypeRef =
  | { readonly kind: 'named'; readonly name: string }
  | { readonly kind: 'list'; readonly ofType: TypeRef }
  | { readonly kind: 'non_null'; readonly ofType: TypeRef };

export function ref(text: string): TypeRef {
  const trimmed = text.trim();
  if (trimmed.endsWith('!')) return { kind: 'non_null', ofType: ref(trimmed.slice(0, -1)) };
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return { kind: 'list', ofType: ref(trimmed.slice(1, -1)) };
  return { kind: 'named', name: trimmed };
}

export interface ArgSpec {
  readonly name: string;
  readonly type: TypeRef;
  readonly defaultValue?: string;
}

export interface FieldSpec {
  readonly name: string;
  readonly type: TypeRef;
  readonly args?: readonly ArgSpec[];
  readonly description?: string;
  readonly deprecated?: boolean;
  readonly deprecationReason?: string;
}

export interface InputFieldSpec {
  readonly name: string;
  readonly type: TypeRef;
  readonly defaultValue?: string;
  readonly description?: string;
}

export interface EnumValueSpec {
  readonly name: string;
  readonly description?: string;
  readonly deprecated?: boolean;
  readonly deprecationReason?: string;
}

export type TypeKind = 'SCALAR' | 'OBJECT' | 'INTERFACE' | 'UNION' | 'ENUM' | 'INPUT_OBJECT';

export interface TypeSpec {
  readonly kind: TypeKind;
  readonly name: string;
  readonly description?: string;
  readonly fields?: readonly FieldSpec[];
  readonly enumValues?: readonly EnumValueSpec[];
  readonly inputFields?: readonly InputFieldSpec[];
  readonly interfaces?: readonly string[];
  readonly possibleTypes?: readonly string[];
}

const f = (name: string, type: string, args: readonly ArgSpec[] = [], description?: string): FieldSpec =>
  description === undefined ? { name, type: ref(type), args } : { name, type: ref(type), args, description };
const a = (name: string, type: string, defaultValue?: string): ArgSpec =>
  defaultValue === undefined ? { name, type: ref(type) } : { name, type: ref(type), defaultValue };
const e = (name: string): EnumValueSpec => ({ name });

const TYPES = new Map<string, TypeSpec>();

function add(type: TypeSpec): void {
  TYPES.set(type.name, type);
}

function object(name: string, fields: readonly FieldSpec[], interfaces: readonly string[] = []): void {
  add({ kind: 'OBJECT', name, fields, interfaces });
}

function enums(name: string, values: readonly string[]): void {
  add({ kind: 'ENUM', name, enumValues: values.map(e) });
}

function input(name: string, fields: readonly InputFieldSpec[]): void {
  add({ kind: 'INPUT_OBJECT', name, inputFields: fields });
}

for (const scalar of ['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'GitObjectID', 'URI']) {
  add({ kind: 'SCALAR', name: scalar });
}

enums('IssueState', ['OPEN', 'CLOSED']);
enums('PullRequestState', ['OPEN', 'CLOSED', 'MERGED']);
enums('MergeableState', ['MERGEABLE', 'CONFLICTING', 'UNKNOWN']);
enums('RepositoryPermission', ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ']);
enums('SearchType', ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION']);
enums('IssueOrderField', ['CREATED_AT', 'UPDATED_AT', 'COMMENTS']);
enums('PullRequestOrderField', ['CREATED_AT', 'UPDATED_AT']);
enums('OrderDirection', ['ASC', 'DESC']);
enums('PullRequestMergeMethod', ['MERGE', 'SQUASH', 'REBASE']);
enums('IssueStateReason', ['COMPLETED', 'NOT_PLANNED', 'REOPENED']);
enums('PullRequestReviewDecision', ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']);
enums('MergeStateStatus', ['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE']);
enums('DiffSide', ['LEFT', 'RIGHT']);
enums('__TypeKind', ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL']);
enums('__DirectiveLocation', [
  'QUERY',
  'MUTATION',
  'SUBSCRIPTION',
  'FIELD',
  'FRAGMENT_DEFINITION',
  'FRAGMENT_SPREAD',
  'INLINE_FRAGMENT',
  'VARIABLE_DEFINITION',
  'SCHEMA',
  'SCALAR',
  'OBJECT',
  'FIELD_DEFINITION',
  'ARGUMENT_DEFINITION',
  'INTERFACE',
  'UNION',
  'ENUM',
  'ENUM_VALUE',
  'INPUT_OBJECT',
  'INPUT_FIELD_DEFINITION',
]);

input('IssueOrder', [
  { name: 'field', type: ref('IssueOrderField!') },
  { name: 'direction', type: ref('OrderDirection!') },
]);
input('PullRequestOrder', [
  { name: 'field', type: ref('PullRequestOrderField!') },
  { name: 'direction', type: ref('OrderDirection!') },
]);
input('CreateIssueInput', [
  { name: 'repositoryId', type: ref('ID!') },
  { name: 'title', type: ref('String!') },
  { name: 'body', type: ref('String') },
  { name: 'labelIds', type: ref('[ID!]') },
  { name: 'assigneeIds', type: ref('[ID!]') },
  { name: 'milestoneId', type: ref('ID') },
  { name: 'clientMutationId', type: ref('String') },
]);
input('CloseIssueInput', [
  { name: 'issueId', type: ref('ID!') },
  { name: 'stateReason', type: ref('IssueStateReason') },
  { name: 'clientMutationId', type: ref('String') },
]);
input('ReopenIssueInput', [
  { name: 'issueId', type: ref('ID!') },
  { name: 'clientMutationId', type: ref('String') },
]);
input('UpdateIssueInput', [
  { name: 'id', type: ref('ID!') },
  { name: 'title', type: ref('String') },
  { name: 'body', type: ref('String') },
  { name: 'state', type: ref('IssueState') },
  { name: 'labels', type: ref('[String!]') },
  { name: 'assigneeIds', type: ref('[ID!]') },
  { name: 'milestoneId', type: ref('ID') },
  { name: 'clientMutationId', type: ref('String') },
]);
input('AddCommentInput', [
  { name: 'subjectId', type: ref('ID!') },
  { name: 'body', type: ref('String!') },
  { name: 'clientMutationId', type: ref('String') },
]);
input('CreatePullRequestInput', [
  { name: 'repositoryId', type: ref('ID!') },
  { name: 'baseRefName', type: ref('String!') },
  { name: 'headRefName', type: ref('String!') },
  { name: 'title', type: ref('String!') },
  { name: 'body', type: ref('String') },
  { name: 'draft', type: ref('Boolean') },
  { name: 'maintainerCanModify', type: ref('Boolean') },
  { name: 'clientMutationId', type: ref('String') },
]);
input('MergePullRequestInput', [
  { name: 'pullRequestId', type: ref('ID!') },
  { name: 'mergeMethod', type: ref('PullRequestMergeMethod') },
  { name: 'commitHeadline', type: ref('String') },
  { name: 'commitBody', type: ref('String') },
  { name: 'expectedHeadOid', type: ref('GitObjectID') },
  { name: 'clientMutationId', type: ref('String') },
]);

add({
  kind: 'INTERFACE',
  name: 'Node',
  fields: [f('id', 'ID!')],
  possibleTypes: ['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User', 'Label', 'Ref', 'Commit'],
});

object('PageInfo', [
  f('hasNextPage', 'Boolean!'),
  f('hasPreviousPage', 'Boolean!'),
  f('startCursor', 'String'),
  f('endCursor', 'String'),
]);

object('User', [
  f('id', 'ID!'),
  f('databaseId', 'Int'),
  f('login', 'String!'),
  f('name', 'String'),
  f('email', 'String!'),
  f('avatarUrl', 'URI!'),
  f('url', 'URI!'),
  f('bio', 'String'),
  f('company', 'String'),
  f('createdAt', 'DateTime'),
  f('isViewer', 'Boolean!'),
  f('isSiteAdmin', 'Boolean!'),
], ['Node']);

object('Label', [
  f('id', 'ID!'),
  f('name', 'String!'),
  f('color', 'String!'),
  f('description', 'String!'),
  f('isDefault', 'Boolean!'),
], ['Node']);

object('LabelEdge', [f('cursor', 'String!'), f('node', 'Label!')]);
object('LabelConnection', [
  f('nodes', '[Label!]!'),
  f('edges', '[LabelEdge!]!'),
  f('pageInfo', 'PageInfo!'),
  f('totalCount', 'Int!'),
]);

object('Ref', [
  f('id', 'ID!'),
  f('name', 'String!'),
  f('prefix', 'String!'),
  f('target', 'Commit'),
  f('repository', 'Repository!'),
], ['Node']);

object('Tree', [f('id', 'ID!'), f('oid', 'GitObjectID!'), f('entries', '[TreeEntry!]')]);
object('TreeEntry', [f('name', 'String!'), f('type', 'String!'), f('mode', 'Int!'), f('oid', 'GitObjectID!')]);

object('Commit', [
  f('id', 'ID!'),
  f('oid', 'GitObjectID!'),
  f('abbreviatedOid', 'String!'),
  f('message', 'String!'),
  f('messageHeadline', 'String!'),
  f('committedDate', 'DateTime!'),
  f('authoredDate', 'DateTime!'),
  f('author', 'User'),
  f('committer', 'User'),
  f('tree', 'Tree'),
  f('url', 'URI!'),
], ['Node']);

object('IssueComment', [
  f('id', 'ID!'),
  f('body', 'String!'),
  f('bodyText', 'String!'),
  f('author', 'User'),
  f('createdAt', 'DateTime!'),
  f('updatedAt', 'DateTime!'),
  f('url', 'URI!'),
  f('isMinimized', 'Boolean!'),
  f('issue', 'Issue'),
  f('pullRequest', 'PullRequest'),
], ['Node']);
object('IssueCommentEdge', [f('cursor', 'String!'), f('node', 'IssueComment!')]);
object('IssueCommentConnection', [
  f('nodes', '[IssueComment!]!'),
  f('edges', '[IssueCommentEdge!]!'),
  f('pageInfo', 'PageInfo!'),
  f('totalCount', 'Int!'),
]);

object('Issue', [
  f('id', 'ID!'),
  f('number', 'Int!'),
  f('title', 'String!'),
  f('state', 'IssueState!'),
  f('stateReason', 'IssueStateReason'),
  f('body', 'String!'),
  f('bodyText', 'String!'),
  f('createdAt', 'DateTime!'),
  f('updatedAt', 'DateTime!'),
  f('closedAt', 'DateTime'),
  f('author', 'User'),
  f('editor', 'User'),
  f('repository', 'Repository!'),
  f('labels', '[Label!]!'),
  f('comments', '[IssueComment!]!', [a('first', 'Int'), a('after', 'String'), a('last', 'Int'), a('before', 'String')]),
  f('url', 'URI!'),
  f('locked', 'Boolean!'),
  f('isPinned', 'Boolean!'),
], ['Node']);
object('IssueEdge', [f('cursor', 'String!'), f('node', 'Issue!')]);
object('IssueConnection', [
  f('nodes', '[Issue!]!'),
  f('edges', '[IssueEdge!]!'),
  f('pageInfo', 'PageInfo!'),
  f('totalCount', 'Int!'),
]);

object('PullRequestChangedFile', [
  f('path', 'String!'),
  f('additions', 'Int!'),
  f('deletions', 'Int!'),
  f('changeType', 'String!'),
  f('viewerViewedState', 'String'),
]);
object('PullRequestChangedFileEdge', [f('cursor', 'String!'), f('node', 'PullRequestChangedFile!')]);
object('PullRequestChangedFileConnection', [
  f('nodes', '[PullRequestChangedFile!]!'),
  f('edges', '[PullRequestChangedFileEdge!]!'),
  f('pageInfo', 'PageInfo!'),
  f('totalCount', 'Int!'),
]);

object('PullRequest', [
  f('id', 'ID!'),
  f('number', 'Int!'),
  f('state', 'PullRequestState!'),
  f('merged', 'Boolean!'),
  f('mergedAt', 'DateTime'),
  f('closedAt', 'DateTime'),
  f('createdAt', 'DateTime!'),
  f('updatedAt', 'DateTime!'),
  f('title', 'String!'),
  f('body', 'String!'),
  f('headRefName', 'String!'),
  f('baseRefName', 'String!'),
  f('mergeable', 'MergeableState!'),
  f('mergeStateStatus', 'MergeStateStatus!'),
  f('isDraft', 'Boolean!'),
  f('author', 'User'),
  f('editor', 'User'),
  f('repository', 'Repository!'),
  f('baseRef', 'Ref'),
  f('headRef', 'Ref'),
  f('mergeCommit', 'Commit'),
  f('files', 'PullRequestChangedFileConnection!', [a('first', 'Int'), a('after', 'String'), a('last', 'Int'), a('before', 'String')]),
  f('additions', 'Int!'),
  f('deletions', 'Int!'),
  f('changedFiles', 'Int!'),
  f('url', 'URI!'),
], ['Node']);
object('PullRequestEdge', [f('cursor', 'String!'), f('node', 'PullRequest!')]);
object('PullRequestConnection', [
  f('nodes', '[PullRequest!]!'),
  f('edges', '[PullRequestEdge!]!'),
  f('pageInfo', 'PageInfo!'),
  f('totalCount', 'Int!'),
]);

object('Repository', [
  f('id', 'ID!'),
  f('databaseId', 'Int'),
  f('name', 'String!'),
  f('nameWithOwner', 'String!'),
  f('description', 'String'),
  f('owner', 'User!'),
  f('defaultBranchRef', 'Ref'),
  f('viewerPermission', 'RepositoryPermission!'),
  f('hasIssuesEnabled', 'Boolean!'),
  f('isPrivate', 'Boolean!'),
  f('createdAt', 'DateTime!'),
  f('updatedAt', 'DateTime!'),
  f('url', 'URI!'),
  f('sshUrl', 'String!'),
  f('issue', 'Issue', [a('number', 'Int!')]),
  f('issues', 'IssueConnection!', [
    a('first', 'Int'),
    a('last', 'Int'),
    a('after', 'String'),
    a('before', 'String'),
    a('states', '[IssueState!]'),
    a('orderBy', 'IssueOrder'),
    a('labels', '[String!]'),
  ]),
  f('pullRequest', 'PullRequest', [a('number', 'Int!')]),
  f('pullRequests', 'PullRequestConnection!', [
    a('first', 'Int'),
    a('last', 'Int'),
    a('after', 'String'),
    a('before', 'String'),
    a('states', '[PullRequestState!]'),
    a('headRefName', 'String'),
    a('baseRefName', 'String'),
    a('orderBy', 'PullRequestOrder'),
  ]),
  f('labels', 'LabelConnection!', [a('first', 'Int'), a('after', 'String')]),
  f('ref', 'Ref', [a('qualifiedName', 'String!')]),
], ['Node']);

object('CreateIssuePayload', [f('issue', 'Issue'), f('clientMutationId', 'String')]);
object('CloseIssuePayload', [f('issue', 'Issue'), f('clientMutationId', 'String')]);
object('ReopenIssuePayload', [f('issue', 'Issue'), f('clientMutationId', 'String')]);
object('UpdateIssuePayload', [f('issue', 'Issue'), f('clientMutationId', 'String')]);
object('AddCommentPayload', [f('commentEdge', 'IssueCommentEdge'), f('clientMutationId', 'String')]);
object('CreatePullRequestPayload', [f('pullRequest', 'PullRequest'), f('clientMutationId', 'String')]);
object('MergePullRequestPayload', [f('pullRequest', 'PullRequest'), f('clientMutationId', 'String')]);

object('Query', [
  f('viewer', 'User!'),
  f('user', 'User', [a('login', 'String!')]),
  f('repository', 'Repository', [a('owner', 'String!'), a('name', 'String!')]),
  f('node', 'Node', [a('id', 'ID!')]),
  f('nodes', '[Node]!', [a('ids', '[ID!]!')]),
  f('__type', '__Type', [a('name', 'String!')]),
  f('__schema', '__Schema!'),
]);

object('Mutation', [
  f('createIssue', 'CreateIssuePayload', [a('input', 'CreateIssueInput!')]),
  f('closeIssue', 'CloseIssuePayload', [a('input', 'CloseIssueInput!')]),
  f('reopenIssue', 'ReopenIssuePayload', [a('input', 'ReopenIssueInput!')]),
  f('updateIssue', 'UpdateIssuePayload', [a('input', 'UpdateIssueInput!')]),
  f('addComment', 'AddCommentPayload', [a('input', 'AddCommentInput!')]),
  f('createPullRequest', 'CreatePullRequestPayload', [a('input', 'CreatePullRequestInput!')]),
  f('mergePullRequest', 'MergePullRequestPayload', [a('input', 'MergePullRequestInput!')]),
]);

object('__Schema', [
  f('description', 'String'),
  f('types', '[__Type!]!'),
  f('queryType', '__Type!'),
  f('mutationType', '__Type'),
  f('subscriptionType', '__Type'),
  f('directives', '[__Directive!]!'),
]);
object('__Type', [
  f('kind', '__TypeKind!'),
  f('name', 'String'),
  f('description', 'String'),
  f('specifiedByURL', 'String'),
  f('fields', '[__Field!]', [a('includeDeprecated', 'Boolean')]),
  f('interfaces', '[__Type!]'),
  f('possibleTypes', '[__Type!]'),
  f('enumValues', '[__EnumValue!]', [a('includeDeprecated', 'Boolean')]),
  f('inputFields', '[__InputValue!]', [a('includeDeprecated', 'Boolean')]),
  f('ofType', '__Type'),
]);
object('__Field', [
  f('name', 'String!'),
  f('description', 'String'),
  f('args', '[__InputValue!]!', [a('includeDeprecated', 'Boolean')]),
  f('type', '__Type!'),
  f('isDeprecated', 'Boolean!'),
  f('deprecationReason', 'String'),
]);
object('__InputValue', [
  f('name', 'String!'),
  f('description', 'String'),
  f('type', '__Type!'),
  f('defaultValue', 'String'),
  f('isDeprecated', 'Boolean!'),
  f('deprecationReason', 'String'),
]);
object('__EnumValue', [
  f('name', 'String!'),
  f('description', 'String'),
  f('isDeprecated', 'Boolean!'),
  f('deprecationReason', 'String'),
]);
object('__Directive', [
  f('name', 'String!'),
  f('description', 'String'),
  f('isRepeatable', 'Boolean!'),
  f('locations', '[__DirectiveLocation!]!'),
  f('args', '[__InputValue!]!'),
]);

export function typeSpec(name: string): TypeSpec | undefined {
  return TYPES.get(name);
}

export function fieldOf(typeName: string, fieldName: string): FieldSpec | undefined {
  return TYPES.get(typeName)?.fields?.find((field) => field.name === fieldName);
}

export function allTypes(): TypeSpec[] {
  return [...TYPES.values()];
}

export function typeKindOf(name: string): TypeKind {
  return TYPES.get(name)?.kind ?? 'SCALAR';
}

export function enumHas(typeName: string, value: string): boolean {
  return TYPES.get(typeName)?.enumValues?.some((entry) => entry.name === value) ?? false;
}

/** The introspection rendering of a type reference: kind, name and ofType recursively. */
export function introspectionRef(type: TypeRef): Record<string, unknown> {
  if (type.kind === 'non_null') return { kind: 'NON_NULL', name: null, ofType: introspectionRef(type.ofType) };
  if (type.kind === 'list') return { kind: 'LIST', name: null, ofType: introspectionRef(type.ofType) };
  return { kind: typeKindOf(type.name), name: type.name, ofType: null };
}

/** A named type's introspection wrapper, or null for an unknown name. */
export function introspectionType(name: string): Record<string, unknown> | null {
  const spec = TYPES.get(name);
  if (spec === undefined) return null;
  return {
    __typename: '__Type',
    name: spec.name,
    kind: spec.kind,
    description: spec.description ?? null,
    fields: spec.fields ?? null,
    enumValues: spec.enumValues ?? null,
    inputFields: spec.inputFields ?? null,
    interfaces: spec.interfaces ?? [],
    possibleTypes: spec.possibleTypes ?? [],
    ofType: null,
  };
}
