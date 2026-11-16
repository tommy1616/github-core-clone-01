// The forge's HTTP server: the boot probe, REST v3 under /api/v3, and a JSON 404 for everything
// else. Every reply carries an X-GitHub-Request-Id; an unexpected throw is a 500 JSON error, never
// a crash or an HTML page.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { HttpError, errorBody, originOf, sendJson, type RequestContext } from './http.ts';
import { Store } from './store.ts';
import { handleRest } from './rest/index.ts';
import { handleGit } from './git/smart-http.ts';

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `ghreq-${requestCounter.toString(16).padStart(8, '0')}`;
}

async function handle(ctx: RequestContext): Promise<void> {
  const { req, res } = ctx;
  const method = req.method ?? 'GET';
  const pathname = ctx.url.pathname;

  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (await handleGit(ctx)) return;

  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    if (await handleRest(ctx)) return;
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

function clientError(_error: Error, socket: import('node:net').Socket): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const body = '{"message":"Bad Request"}\n';
  socket.end(
    `HTTP/1.1 400 Bad Request\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
  );
}

export function createApp(): Server {
  const store = new Store();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const id = requestId();
    res.setHeader('x-github-request-id', id);
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://entry');
    } catch {
      url = new URL('/', 'http://entry');
    }
    const ctx: RequestContext = {
      req,
      res,
      url,
      store,
      origin: originOf(req),
      requestId: id,
    };
    void handle(ctx).catch((err: unknown) => {
      if (res.writableEnded) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, errorBody(err));
        return;
      }
      process.stderr.write(`[rest] internal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      sendJson(res, 500, { message: 'Internal Server Error' });
    });
  });

  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  server.requestTimeout = 0;
  server.timeout = 0;
  server.on('clientError', (error: Error, socket: import('node:net').Socket) => clientError(error, socket));
  return server;
}
