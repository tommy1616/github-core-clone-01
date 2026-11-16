// The REST bearer-token check, shared by the route table and the hot-path issue read.

import type { IncomingMessage } from 'node:http';

function headerToken(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = /^(?:Bearer|token)\s+(.+)$/i.exec(value.trim());
  return match === null ? null : (match[1] as string);
}

export function authorizedRequest(req: IncomingMessage): boolean {
  const presented = headerToken(req.headers.authorization);
  if (presented === null) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  return presented === expected;
}
