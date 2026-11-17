// app.ts — the HTTP server: one process, one store, four surfaces.
//
// Routing:
//   GET  /healthz                       -> {ok:true} (no auth)
//   /api/v3/*                           -> REST v3 (Bearer auth)
//   POST /api/graphql                  -> GraphQL (Bearer auth)
//   POST /mcp                          -> MCP JSON-RPC (Bearer auth)
//   /{owner}/{repo}.git/info/refs      -> git advertisement (no auth)
//   /{owner}/{repo}.git/git-upload-pack -> git fetch / ls-refs (no auth)
//   /{owner}/{repo}.git/git-receive-pack -> git push (no auth)
// Every reply carries X-GitHub-Request-Id. Auth: when MAKEFUN_SHOP_TOKEN is
// set, the Bearer token must match it exactly; when it is unset (local runs)
// any non-empty Bearer token names the viewer.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createStore, type Store } from './store.ts';
import { findGitRepo, handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(payload.length), ...extraHeaders });
  response.end(payload);
}

function sendBuffer(response: ServerResponse, status: number, contentType: string, body: Buffer, extraHeaders: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length), ...extraHeaders });
  response.end(body);
}

export interface ForgeApp {
  server: Server;
  listen: (port: number) => Promise<number>;
}

export function createApp(store: Store = createStore()): ForgeApp {
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestSeq = 0;

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((err: Error) => {
      console.error(`[forge] request failed: ${err.message}`);
      if (!response.headersSent) sendJson(response, 500, { message: 'Internal error' }, { 'x-github-request-id': `req-${(++requestSeq).toString(16).padStart(8, '0')}` });
      else response.end();
    });
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = `req-${(++requestSeq).toString(16).padStart(8, '0')}`;
    const common = { 'x-github-request-id': requestId };
    const method = (request.method ?? 'GET').toUpperCase();
    const rawUrl = request.url ?? '/';
    let url: URL;
    try {
      url = new URL(rawUrl, 'http://localhost');
    } catch {
      sendJson(response, 400, { message: 'Bad URL' }, common);
      return;
    }
    const host = request.headers.host ?? 'localhost';
    const origin = `http://${host}`;
    const rawSegments = url.pathname.split('/').filter((segment) => segment !== '');
    const segments: string[] = [];
    for (const segment of rawSegments) {
      try {
        segments.push(decodeURIComponent(segment));
      } catch {
        sendJson(response, 400, { message: 'Bad path encoding' }, common);
        return;
      }
    }

    const body = await readBody(request);

    const authorized = (): boolean => {
      const header = request.headers.authorization ?? '';
      if (!header.startsWith('Bearer ')) return false;
      const token = header.slice('Bearer '.length).trim();
      if (token === '') return false;
      if (expectedToken !== '') return token === expectedToken;
      return true;
    };

    // GET /healthz — no auth.
    if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
      sendJson(response, 200, { ok: true }, common);
      return;
    }

    // Git smart HTTP — no auth.
    if (segments.length >= 3 && segments[1]?.endsWith('.git')) {
      const owner = segments[0] as string;
      const repoName = (segments[1] as string).slice(0, -'.git'.length);
      const action = segments[2] as string;
      if (action === 'info' && segments.length === 4 && segments[3] === 'refs' && method === 'GET') {
        const service = url.searchParams.get('service') ?? '';
        const gitProtocol2 = (request.headers['git-protocol'] ?? '') === 'version=2';
        const result = handleInfoRefs(store, owner, repoName, service, gitProtocol2);
        sendBuffer(response, result.status, result.contentType, result.body, common);
        return;
      }
      const repo = findGitRepo(store, owner, repoName);
      if (!repo) {
        sendJson(response, 404, { message: 'Not Found' }, common);
        return;
      }
      if (action === 'git-upload-pack' && segments.length === 3 && method === 'POST') {
        const gitProtocol2 = (request.headers['git-protocol'] ?? '') === 'version=2';
        const result = handleUploadPack(repo, body, gitProtocol2);
        sendBuffer(response, result.status, result.contentType, result.body, common);
        return;
      }
      if (action === 'git-receive-pack' && segments.length === 3 && method === 'POST') {
        const result = handleReceivePack(repo, body);
        sendBuffer(response, result.status, result.contentType, result.body, common);
        return;
      }
      sendJson(response, 404, { message: 'Not Found' }, common);
      return;
    }

    // Everything below needs a Bearer token.
    if (!authorized()) {
      sendJson(response, 401, { message: 'Requires authentication' }, common);
      return;
    }

    // REST v3.
    if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
      let parsedBody: unknown;
      if (body.length > 0) {
        try {
          parsedBody = JSON.parse(body.toString('utf8'));
        } catch {
          sendJson(response, 400, { message: 'Invalid JSON' }, common);
          return;
        }
      }
      const restRequest: RestRequest = {
        method,
        path: url.pathname,
        segments: segments.slice(2),
        query: url.searchParams,
        body: parsedBody,
        origin,
      };
      const result = handleRest(store, restRequest);
      const headers: Record<string, string> = { ...common, 'x-oauth-scopes': 'repo, user', ...(result.headers ?? {}) };
      if (result.status === 204 || result.body === undefined) {
        response.writeHead(result.status, headers);
        response.end();
        return;
      }
      sendJson(response, result.status, result.body, headers);
      return;
    }

    // GraphQL.
    if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
      if (method !== 'POST') {
        sendJson(response, 404, { message: 'Not Found' }, common);
        return;
      }
      let parsedBody: unknown;
      try {
        parsedBody = body.length > 0 ? JSON.parse(body.toString('utf8')) : null;
      } catch {
        sendJson(response, 400, { message: 'Invalid JSON' }, common);
        return;
      }
      const result = handleGraphQL(store, parsedBody);
      sendJson(response, result.status, result.body, common);
      return;
    }

    // MCP.
    if (segments.length === 1 && segments[0] === 'mcp') {
      if (method === 'DELETE') {
        sendJson(response, 405, { message: 'Method Not Allowed' }, common);
        return;
      }
      if (method !== 'POST') {
        sendJson(response, 404, { message: 'Not Found' }, common);
        return;
      }
      const result = handleMcp(store, body, origin);
      sendBuffer(response, result.status, result.contentType, result.body, common);
      return;
    }

    sendJson(response, 404, { message: 'Not Found' }, common);
  }

  return {
    server,
    listen(port: number): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          const address = server.address();
          if (address === null || typeof address === 'string') {
            reject(new Error('server did not bind a port'));
            return;
          }
          resolve(address.port);
        });
      });
    },
  };
}
