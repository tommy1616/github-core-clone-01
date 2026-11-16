// The Model Context Protocol endpoint: JSON-RPC 2.0 over Streamable HTTP. Modern 2026-07-28
// requests declare their revision in headers/_meta and get server/discover; the legacy initialize
// handshake and notifications also work. Replies are JSON unless the client accepts only SSE.

import { readBody, sendJson, type RequestContext } from '../http.ts';
import { MCP_TOOLS, callTool, isKnownTool } from './tools.ts';

const SERVER_INFO = Object.freeze({ name: 'makefun-forge', version: '1.0.0' });
const SUPPORTED_VERSIONS = Object.freeze(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26']);
const DISCOVER_RESULT = Object.freeze({
  resultType: 'complete',
  supportedVersions: SUPPORTED_VERSIONS,
  serverInfo: SERVER_INFO,
  capabilities: { tools: { listChanged: false } },
  instructions: 'GitHub-compatible forge tools over the trial store.',
  _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
});

type JsonRecord = Record<string, unknown>;

function authorized(ctx: RequestContext): boolean {
  const header = ctx.req.headers.authorization;
  if (typeof header !== 'string' || header === '') return false;
  const match = /^(?:Bearer|token)\s+(.+)$/i.exec(header.trim());
  if (match === null) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return expected === '' || match[1] === expected;
}

function isRevision(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function errorEnvelope(id: unknown, code: number, message: string, data?: unknown): JsonRecord {
  const error: JsonRecord = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error };
}

function resultEnvelope(id: unknown, result: unknown): JsonRecord {
  return { jsonrpc: '2.0', id, result };
}

function processMessage(ctx: RequestContext, message: unknown): JsonRecord | null {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return errorEnvelope(null, -32600, 'Invalid Request');
  }
  const request = message as JsonRecord;
  const hasId = Object.prototype.hasOwnProperty.call(request, 'id');
  const id = request.id;
  const method = request.method;
  if (typeof method !== 'string' || method === '') {
    return hasId ? errorEnvelope(id, -32600, 'Invalid Request') : null;
  }
  const params = typeof request.params === 'object' && request.params !== null && !Array.isArray(request.params)
    ? (request.params as JsonRecord)
    : {};

  if (method === 'server/discover') return hasId ? resultEnvelope(id, DISCOVER_RESULT) : null;
  if (method === 'initialize') {
    if (!hasId) return null;
    const offered = params.protocolVersion;
    const protocolVersion = isRevision(offered) && SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return resultEnvelope(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: 'GitHub-compatible forge tools over the trial store.',
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
  if (method === 'ping') return hasId ? resultEnvelope(id, {}) : null;
  if (method === 'tools/list') return hasId ? resultEnvelope(id, { tools: MCP_TOOLS }) : null;
  if (method === 'tools/call') {
    if (!hasId) return null;
    const name = params.name;
    if (typeof name !== 'string' || name === '') return errorEnvelope(id, -32602, 'Invalid params: name is required');
    if (!isKnownTool(name)) return errorEnvelope(id, -32602, `Unknown tool: ${name}`);
    const args = typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};
    const result = callTool(ctx, name, args);
    if (result === null) return errorEnvelope(id, -32602, `Unknown tool: ${name}`);
    return resultEnvelope(id, result);
  }
  return hasId ? errorEnvelope(id, -32601, `Method not found: ${method}`) : null;
}

function wantsSseOnly(ctx: RequestContext): boolean {
  const accept = String(ctx.req.headers.accept ?? '').toLowerCase();
  if (!accept.includes('text/event-stream')) return false;
  return !accept.includes('application/json') && !accept.includes('*/*');
}

function sendPayload(ctx: RequestContext, payload: unknown): void {
  if (wantsSseOnly(ctx)) {
    const frames = (Array.isArray(payload) ? payload : [payload]).map((entry) => `event: message\ndata: ${JSON.stringify(entry)}\n\n`).join('');
    ctx.res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    ctx.res.end(frames);
    return;
  }
  sendJson(ctx.res, 200, payload);
}

export async function handleMcp(ctx: RequestContext): Promise<boolean> {
  if (ctx.url.pathname !== '/mcp') return false;
  const method = ctx.req.method ?? 'GET';

  if (method === 'GET') {
    ctx.req.resume();
    sendJson(ctx.res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (method === 'DELETE') {
    ctx.req.resume();
    ctx.res.writeHead(204);
    ctx.res.end();
    return true;
  }
  if (method !== 'POST') {
    ctx.req.resume();
    sendJson(ctx.res, 405, { message: 'Method Not Allowed' });
    return true;
  }

  if (!authorized(ctx)) {
    ctx.req.resume();
    sendJson(ctx.res, 401, errorEnvelope(null, -32001, 'Unauthorized'));
    return true;
  }

  const bytes = await readBody(ctx.req);
  let body: unknown;
  try {
    body = bytes.length === 0 ? null : JSON.parse(bytes.toString('utf8'));
  } catch {
    sendJson(ctx.res, 400, errorEnvelope(null, -32700, 'Parse error'));
    return true;
  }

  if (Array.isArray(body)) {
    const responses: JsonRecord[] = [];
    for (const message of body) {
      const response = processMessage(ctx, message);
      if (response !== null) responses.push(response);
    }
    if (responses.length === 0) {
      ctx.res.writeHead(202);
      ctx.res.end();
      return true;
    }
    sendPayload(ctx, responses);
    return true;
  }

  const response = processMessage(ctx, body);
  if (response === null) {
    ctx.res.writeHead(202);
    ctx.res.end();
    return true;
  }
  sendPayload(ctx, response);
  return true;
}
