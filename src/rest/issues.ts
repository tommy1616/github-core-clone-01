// Issues, labels and comments. A label must exist in the repository before an issue may carry
// it; an unknown label is GitHub's 422, not a silent drop.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  HttpError,
  errorBody,
  queryInt,
  readJsonBody,
  sendJson,
  sendJsonBuffer,
  stringField,
  type RequestContext,
} from '../http.ts';
import type { Issue, Repo, Store } from '../store.ts';
import { serializeComment, serializeIssue, serializeIssueJson, serializeLabel } from './serialize.ts';
import { repoOr404 } from './repos.ts';
import { authorizedRequest } from './auth.ts';
import type { RouteHandler } from './index.ts';

function issueOr404(repo: Repo, number: number): Issue {
  const issue = repo.issues.get(number);
  if (issue === undefined) throw new HttpError(404, 'Not Found');
  return issue;
}

/** The hot path for GET /repos/{o}/{r}/issues/{n}: bearer check, lookup, cached JSON buffer. */
export function fastGetIssue(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  origin: string,
  rawOwner: string,
  rawRepo: string,
  number: number,
): void {
  if (!authorizedRequest(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }
  let owner: string;
  let repoName: string;
  try {
    owner = rawOwner.includes('%') ? decodeURIComponent(rawOwner) : rawOwner;
    repoName = rawRepo.includes('%') ? decodeURIComponent(rawRepo) : rawRepo;
  } catch {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const repo = store.requireRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  sendJsonBuffer(res, 200, serializeIssueJson(origin, repo, issue).buffer);
}

function createIssueFromBody(store: Store, repo: Repo, body: Record<string, unknown>): Issue {
  const title = stringField(body.title);
  if (title === undefined || title.trim() === '') {
    throw new HttpError(422, 'Validation Failed', {
      errors: [{ resource: 'Issue', code: 'missing_field', field: 'title', message: 'title is required' }],
    });
  }
  const text = body.body === null || body.body === undefined ? '' : stringField(body.body) ?? '';
  const labels = validLabels(store, repo, labelNamesFrom(body));
  return store.createIssue(repo, { title, body: text, labels });
}

/** The hot path for POST /repos/{o}/{r}/issues: no URL parse or route cascade, cached JSON reply. */
export async function fastCreateIssue(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  origin: string,
  rawOwner: string,
  rawRepo: string,
): Promise<void> {
  try {
    if (!authorizedRequest(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    let owner: string;
    let repoName: string;
    try {
      owner = rawOwner.includes('%') ? decodeURIComponent(rawOwner) : rawOwner;
      repoName = rawRepo.includes('%') ? decodeURIComponent(rawRepo) : rawRepo;
    } catch {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const repo = store.requireRepo(owner, repoName);
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const body = await readJsonBody(req);
    const issue = createIssueFromBody(store, repo, body);
    sendJsonBuffer(res, 201, serializeIssueJson(origin, repo, issue).buffer);
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, errorBody(err));
      return;
    }
    sendJson(res, 500, { message: 'Internal Server Error' });
  }
}

function labelNamesFrom(body: Record<string, unknown>): string[] {
  const raw = body.labels;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new HttpError(422, 'Validation Failed', {
      errors: [{ resource: 'Issue', code: 'invalid', field: 'labels', message: 'labels must be an array' }],
    });
  }
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') names.push(item);
    else if (typeof item === 'object' && item !== null) {
      const name = stringField((item as Record<string, unknown>).name);
      if (name === undefined) {
        throw new HttpError(422, 'Validation Failed', {
          errors: [{ resource: 'Issue', code: 'invalid', field: 'labels', message: 'each label needs a name' }],
        });
      }
      names.push(name);
    } else {
      throw new HttpError(422, 'Validation Failed', {
        errors: [{ resource: 'Issue', code: 'invalid', field: 'labels', message: 'labels must be names' }],
      });
    }
  }
  return names;
}

function validLabels(store: Store, repo: Repo, names: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    const label = store.findLabel(repo, name);
    if (label === undefined) {
      throw new HttpError(422, 'Validation Failed', {
        errors: [{ resource: 'Issue', code: 'missing', field: 'labels', message: `label ${JSON.stringify(name)} does not exist` }],
      });
    }
    if (!out.includes(label.name)) out.push(label.name);
  }
  return out;
}

async function issuesHandler(ctx: RequestContext, owner: string, name: string): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if ((ctx.req.method ?? 'GET') === 'POST') {
    const body = await readJsonBody(ctx.req);
    const issue = createIssueFromBody(ctx.store, repo, body);
    sendJson(ctx.res, 201, serializeIssue(ctx.origin, repo, issue));
    return;
  }

  const state = ctx.url.searchParams.get('state') ?? 'open';
  const sort = ctx.url.searchParams.get('sort') ?? 'created';
  const direction = ctx.url.searchParams.get('direction') === 'asc' ? 'asc' : 'desc';
  const perPage = queryInt(ctx.url, 'per_page', 30, 1, 100);
  const page = queryInt(ctx.url, 'page', 1, 1, 1_000_000);
  const filterLabels = (ctx.url.searchParams.get('labels') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  let issues = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
  if (filterLabels.length > 0) {
    issues = issues.filter((issue) => filterLabels.every((label) => issue.labels.some((name) => name.toLowerCase() === label.toLowerCase())));
  }
  const sign = direction === 'asc' ? 1 : -1;
  issues.sort((a, b) => {
    if (sort === 'updated') return (a.updatedAt - b.updatedAt || a.number - b.number) * sign;
    if (sort === 'comments') return (a.comments.length - b.comments.length || a.number - b.number) * sign;
    return (a.seq - b.seq || a.number - b.number) * sign;
  });
  const start = (page - 1) * perPage;
  const slice = issues.slice(start, start + perPage);
  sendJson(ctx.res, 200, slice.map((issue) => serializeIssue(ctx.origin, repo, issue)));
}

async function issueHandler(ctx: RequestContext, owner: string, name: string, rawNumber: string): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  const number = Number(rawNumber);
  const issue = issueOr404(repo, number);
  if ((ctx.req.method ?? 'GET') === 'GET') {
    const cached = serializeIssueJson(ctx.origin, repo, issue);
    sendJsonBuffer(ctx.res, 200, cached.buffer);
    return;
  }
  const body = await readJsonBody(ctx.req);
  if ('title' in body) {
    const title = stringField(body.title);
    if (title === undefined || title.trim() === '') {
      throw new HttpError(422, 'Validation Failed', {
        errors: [{ resource: 'Issue', code: 'missing_field', field: 'title', message: 'title is required' }],
      });
    }
    issue.title = title;
  }
  if ('body' in body) issue.body = body.body === null ? '' : stringField(body.body) ?? issue.body;
  if ('labels' in body) issue.labels = validLabels(ctx.store, repo, labelNamesFrom(body));
  if ('state' in body) {
    const state = stringField(body.state);
    if (state !== 'open' && state !== 'closed') {
      throw new HttpError(422, 'Validation Failed', {
        errors: [{ resource: 'Issue', code: 'invalid', field: 'state', message: 'state must be open or closed' }],
      });
    }
    if (state !== issue.state) {
      issue.state = state;
      issue.closedAt = state === 'closed' ? Date.now() : null;
    }
  }
  issue.updatedAt = Date.now();
  issue.version += 1;
  repo.updatedAt = issue.updatedAt;
  sendJson(ctx.res, 200, serializeIssue(ctx.origin, repo, issue));
}

async function commentsHandler(ctx: RequestContext, owner: string, name: string, rawNumber: string): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  const issue = issueOr404(repo, Number(rawNumber));
  if ((ctx.req.method ?? 'GET') === 'POST') {
    const body = await readJsonBody(ctx.req);
    const text = stringField(body.body);
    if (text === undefined) {
      throw new HttpError(422, 'Validation Failed', {
        errors: [{ resource: 'IssueComment', code: 'missing_field', field: 'body', message: 'body is required' }],
      });
    }
    const comment = ctx.store.createComment(repo, issue, text);
    sendJson(ctx.res, 201, serializeComment(ctx.origin, repo, issue, comment));
    return;
  }
  const comments = [...issue.comments].sort((a, b) => a.id - b.id);
  sendJson(
    ctx.res,
    200,
    comments.map((comment) => serializeComment(ctx.origin, repo, issue, comment)),
  );
}

async function labelsHandler(ctx: RequestContext, owner: string, name: string): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if ((ctx.req.method ?? 'GET') === 'POST') {
    const body = await readJsonBody(ctx.req);
    const labelName = stringField(body.name);
    if (labelName === undefined || labelName.trim() === '') {
      throw new HttpError(422, 'Validation Failed', {
        errors: [{ resource: 'Label', code: 'missing_field', field: 'name', message: 'name is required' }],
      });
    }
    if (ctx.store.findLabel(repo, labelName) !== undefined) {
      throw new HttpError(422, 'Validation Failed', {
        errors: [{ resource: 'Label', code: 'already_exists', field: 'name', message: 'label already exists' }],
      });
    }
    const label = ctx.store.createLabel(repo, {
      name: labelName,
      color: stringField(body.color),
      description: stringField(body.description),
    });
    sendJson(ctx.res, 201, serializeLabel(ctx.origin, repo, label as NonNullable<typeof label>));
    return;
  }
  const labels = [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  sendJson(
    ctx.res,
    200,
    labels.map((label) => serializeLabel(ctx.origin, repo, label)),
  );
}

async function oneLabel(ctx: RequestContext, owner: string, name: string, labelName: string): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  const label = ctx.store.findLabel(repo, labelName);
  if (label === undefined) throw new HttpError(404, 'Not Found');
  const method = ctx.req.method ?? 'GET';
  if (method === 'GET') {
    sendJson(ctx.res, 200, serializeLabel(ctx.origin, repo, label));
    return;
  }
  if (method === 'DELETE') {
    ctx.store.deleteLabel(repo, labelName);
    sendJson(ctx.res, 200, serializeLabel(ctx.origin, repo, label));
    return;
  }
  const body = await readJsonBody(ctx.req);
  const updated = ctx.store.replaceLabel(repo, labelName, {
    newName: stringField(body.new_name),
    color: stringField(body.color),
    description: stringField(body.description),
  });
  if (updated === undefined) throw new HttpError(404, 'Not Found');
  sendJson(ctx.res, 200, serializeLabel(ctx.origin, repo, updated));
}

export function registerIssueRoutes(register: (methods: readonly string[], pattern: RegExp, handler: RouteHandler) => void): void {
  register(['GET', 'POST'], /^\/repos\/([^/]+)\/([^/]+)\/issues$/, (ctx, params) =>
    issuesHandler(ctx, params[0] as string, params[1] as string),
  );
  register(['GET', 'PATCH'], /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/, (ctx, params) =>
    issueHandler(ctx, params[0] as string, params[1] as string, params[2] as string),
  );
  register(['GET', 'POST'], /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/, (ctx, params) =>
    commentsHandler(ctx, params[0] as string, params[1] as string, params[2] as string),
  );
  register(['GET', 'POST'], /^\/repos\/([^/]+)\/([^/]+)\/labels$/, (ctx, params) =>
    labelsHandler(ctx, params[0] as string, params[1] as string),
  );
  register(['GET', 'PATCH', 'DELETE'], /^\/repos\/([^/]+)\/([^/]+)\/labels\/(.+)$/, (ctx, params) =>
    oneLabel(ctx, params[0] as string, params[1] as string, params[2] as string),
  );
}
