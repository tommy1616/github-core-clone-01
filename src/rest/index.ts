// The REST v3 route table, its bearer-token gate and dispatch. Every route lives in one of the
// resource modules; this file only knows their patterns and order.

import { HttpError, sendJson, type RequestContext } from '../http.ts';
import { registerContentRoutes } from './contents.ts';
import { registerIssueRoutes } from './issues.ts';
import { registerPullRoutes } from './pulls.ts';
import { registerRepoRoutes } from './repos.ts';

export type RouteHandler = (ctx: RequestContext, params: string[]) => Promise<void> | void;

interface Route {
  readonly methods: readonly string[];
  readonly pattern: RegExp;
  readonly handler: RouteHandler;
}

const routes: Route[] = [];

export function route(methods: readonly string[], pattern: RegExp, handler: RouteHandler): void {
  routes.push({ methods, pattern, handler });
}

registerRepoRoutes(route);
registerContentRoutes(route);
registerIssueRoutes(route);
registerPullRoutes(route);

function headerToken(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = /^(?:Bearer|token)\s+(.+)$/i.exec(value.trim());
  return match === null ? null : (match[1] as string);
}

function authorized(ctx: RequestContext): boolean {
  const presented = headerToken(ctx.req.headers.authorization);
  if (presented === null) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  return presented === expected;
}

function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Handle an /api/v3 request; answers false when no route matches so the caller can 404. */
export async function handleRest(ctx: RequestContext): Promise<boolean> {
  if (!authorized(ctx)) {
    sendJson(ctx.res, 401, { message: 'Bad credentials' });
    return true;
  }
  const pathname = ctx.url.pathname;
  const path = pathname === '/api/v3' ? '/' : pathname.startsWith('/api/v3/') ? pathname.slice('/api/v3'.length) : null;
  if (path === null) return false;
  const method = ctx.req.method ?? 'GET';
  for (const entry of routes) {
    const match = entry.pattern.exec(path);
    if (match === null) continue;
    if (!entry.methods.includes(method)) continue;
    const params = match.slice(1).map((value) => decodeParam(value ?? ''));
    await entry.handler(ctx, params);
    return true;
  }
  return false;
}

export function notFound(): HttpError {
  return new HttpError(404, 'Not Found');
}
