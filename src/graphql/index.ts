// The /api/graphql endpoint: bearer auth, one operation or a JSON array of operations, and the
// {data, errors} envelope. GraphQL-level failures stay HTTP 200; only auth, malformed JSON and
// transport-level mistakes are HTTP errors.

import { HttpError, readBody, sendJson, type RequestContext } from '../http.ts';
import { executeGraphQL, type ExecutionResult } from './execute.ts';

function authorized(ctx: RequestContext): boolean {
  const header = ctx.req.headers.authorization;
  if (typeof header !== 'string' || header === '') return false;
  const match = /^(?:Bearer|token)\s+(.+)$/i.exec(header.trim());
  if (match === null) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return expected === '' || match[1] === expected;
}

function oneOperation(ctx: RequestContext, value: unknown): ExecutionResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { errors: [{ message: 'Each operation must be a JSON object.' }] };
  }
  const entry = value as Record<string, unknown>;
  const query = entry.query;
  if (typeof query !== 'string') return { errors: [{ message: 'Must provide query string.' }] };
  const variables = typeof entry.variables === 'object' && entry.variables !== null && !Array.isArray(entry.variables)
    ? (entry.variables as Record<string, unknown>)
    : {};
  const operationName = typeof entry.operationName === 'string' ? entry.operationName : null;
  return executeGraphQL(ctx.store, ctx.origin, query, variables, operationName);
}

export async function handleGraphQL(ctx: RequestContext): Promise<boolean> {
  if (ctx.url.pathname !== '/api/graphql') return false;
  if ((ctx.req.method ?? 'GET') !== 'POST') {
    sendJson(ctx.res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (!authorized(ctx)) {
    sendJson(ctx.res, 401, { message: 'Bad credentials' });
    return true;
  }
  const bytes = await readBody(ctx.req);
  let body: unknown;
  try {
    body = bytes.length === 0 ? null : JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  if (Array.isArray(body)) {
    sendJson(ctx.res, 200, body.map((entry) => oneOperation(ctx, entry)));
    return true;
  }
  sendJson(ctx.res, 200, oneOperation(ctx, body));
  return true;
}
