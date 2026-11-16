// The small HTTP helpers every surface shares: JSON replies with the trial's request id on all of
// them, a bounded body reader, and one JSON error type. Nothing here ever returns HTML.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';
export const DEFAULT_BODY_LIMIT = 16 * 1024 * 1024;

export class HttpError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;

  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.extra = extra;
  }
}

export interface RequestContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly store: Store;
  readonly origin: string;
  readonly requestId: string;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  if (res.writableEnded) return;
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': String(Buffer.byteLength(text)),
    ...headers,
  });
  res.end(text);
}

export function sendJsonBuffer(res: ServerResponse, status: number, body: Buffer, headers: Readonly<Record<string, string>> = {}): void {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': String(body.length),
    ...headers,
  });
  res.end(body);
}

export function sendEmpty(res: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  if (res.writableEnded) return;
  res.writeHead(status, headers);
  res.end();
}

/** Read a request body, refusing anything past `limit` bytes with a 413 JSON error. */
export async function readBody(req: IncomingMessage, limit = DEFAULT_BODY_LIMIT): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > limit) throw new HttpError(413, 'Request body is too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** A JSON object body; an empty body is `{}`, malformed bytes are GitHub's 400. */
export async function readJsonBody(req: IncomingMessage, limit = DEFAULT_BODY_LIMIT): Promise<Record<string, unknown>> {
  const bytes = await readBody(req, limit);
  if (bytes.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  return parsed as Record<string, unknown>;
}

export function errorBody(err: HttpError): Record<string, unknown> {
  return { message: err.message, ...err.extra };
}

/** The request's origin (`http://host[:port]`) for absolute GitHub-style links. */
export function originOf(req: IncomingMessage): string {
  const host = typeof req.headers.host === 'string' && req.headers.host !== '' ? req.headers.host : 'localhost';
  return `http://${host}`;
}

export function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function booleanField(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function integerField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

export function queryInt(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
