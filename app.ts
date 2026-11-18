// The forge's HTTP server: one process, one store, four surfaces.
// Routing: /healthz (no auth) -> git smart HTTP -> REST v3 -> GraphQL v4 -> MCP.
// Every reply is JSON with a non-empty X-GitHub-Request-Id; a missing or wrong
// Bearer token is 401 everywhere except /healthz.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, type Ctx } from './rest.ts';
import { handleGit } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = typeof body === 'string' ? body : `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) reject(new Error('body too large'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function lowerHeaders(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = store.nextRequestId();
      const extraHeaders = { 'x-github-request-id': requestId };
      const method = req.method ?? 'GET';
      const path = pathOf(req);
      const headers = lowerHeaders(req);

      try {
        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true }, extraHeaders);
          return;
        }

        // Everything else needs the trial's bearer token.
        const auth = headers.authorization ?? '';
        if (token === '' || auth !== `Bearer ${token}`) {
          sendJson(res, 401, { message: 'Bad credentials' }, extraHeaders);
          return;
        }

        const url = new URL(req.url ?? '/', 'http://entry');
        const query = url.searchParams;

        // Git smart HTTP.
        if (path.includes('.git/')) {
          const rawBody = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
          const gitReply = handleGit(store, method, path, query, headers, rawBody);
          if (gitReply !== null) {
            sendBytes(res, gitReply.status, gitReply.contentType, gitReply.body, extraHeaders);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' }, extraHeaders);
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' }, extraHeaders);
            return;
          }
          const rawBody = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(rawBody.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' }, extraHeaders);
            return;
          }
          const result = handleGraphQL(store, parsed);
          sendJson(res, result.status, result.payload, extraHeaders);
          return;
        }

        // MCP.
        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' }, extraHeaders);
            return;
          }
          const rawBody = await readBody(req);
          const result = handleMcp(store, rawBody);
          if (result.status === 202) {
            res.writeHead(202, { 'content-length': 0, ...extraHeaders });
            res.end();
            return;
          }
          sendJson(res, result.status, result.payload, extraHeaders);
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          let parsed: unknown = null;
          let rawBody = Buffer.alloc(0);
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            rawBody = await readBody(req);
            if (rawBody.length > 0) {
              try {
                parsed = JSON.parse(rawBody.toString('utf8'));
              } catch {
                sendJson(res, 400, { message: 'Problems parsing JSON' }, extraHeaders);
                return;
              }
            }
          }
          const ctx: Ctx = { store, method, path, query, headers, body: parsed, rawBody };
          const reply = handleRest(ctx);
          if (reply === null) {
            sendJson(res, 404, { message: 'Not Found' }, extraHeaders);
            return;
          }
          sendJson(res, reply.status, reply.body, { ...extraHeaders, ...reply.headers });
          return;
        }

        sendJson(res, 404, { message: 'Not Found' }, extraHeaders);
      } catch (err) {
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' }, extraHeaders);
        } catch {
          // The peer went away; nothing to write to.
        }
      }
    })();
  });
}
