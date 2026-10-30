// Minimal, dependency-free MCP client (streamable HTTP) used by dp-mcp-helper.mjs. It
// authenticates on its own (it never borrows Claude Code's MCP session): via MCP OAuth
// (dynamic registration + PKCE) in the user's browser, or via a bearer read from a file
// descriptor or hidden input. Credentials are held in memory only and scrubbed from all output.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

export const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'dp-ai-toolkit-helper', version: '1' };

/** Replaces registered secret values (and their JSON/URL-encoded forms) in text. */
export class Redactor {
  #secrets = new Set();
  add(secret) {
    if (typeof secret !== 'string' || secret.length < 4) return;
    for (const form of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]) this.#secrets.add(form);
  }
  scrub(text) {
    let out = String(text);
    for (const s of this.#secrets) out = out.split(s).join('[REDACTED]');
    return out;
  }
}

export class AuthRequiredError extends Error {
  constructor(wwwAuthenticate) { super('MCP server requires authentication'); this.wwwAuthenticate = wwwAuthenticate; }
}

class RpcIds { #n = 0; next() { return ++this.#n; } }

/** Streamable HTTP transport (JSON or SSE responses). getToken() returns a bearer or undefined. */
export class HttpTransport {
  constructor({ url, getToken, fetchImpl = fetch }) {
    Object.assign(this, { url, getToken, fetchImpl });
    this.ids = new RpcIds();
  }

  start() {}

  async #post(body) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const token = await this.getToken?.();
    if (token) headers.authorization = `Bearer ${token}`;
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion;
    const res = await this.fetchImpl(this.url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (res.status === 401) throw new AuthRequiredError(res.headers.get('www-authenticate') ?? '');
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    return res;
  }

  async rpc(method, params, timeoutMs) {
    const id = this.ids.next();
    const res = await withTimeout(this.#post({ jsonrpc: '2.0', id, method, params }), timeoutMs, method);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} from MCP server for ${method}: ${text.slice(0, 300)}`);
    const type = res.headers.get('content-type') ?? '';
    const messages = type.includes('text/event-stream') ? parseSse(text) : [JSON.parse(text)].flat();
    const reply = messages.find(m => m && m.id === id);
    if (!reply) throw new Error(`No response to ${method} in the server's reply`);
    if (method === 'initialize' && reply.result?.protocolVersion) this.protocolVersion = reply.result.protocolVersion;
    return reply;
  }

  async notify(method, params) {
    const res = await this.#post({ jsonrpc: '2.0', method, params });
    await res.text();
  }

  async close() {
    if (!this.sessionId) return;
    const headers = { 'mcp-session-id': this.sessionId };
    const token = await this.getToken?.();
    if (token) headers.authorization = `Bearer ${token}`;
    try { await this.fetchImpl(this.url, { method: 'DELETE', headers }); } catch { /* best effort */ }
  }
}

export class McpClient {
  constructor(transport, { connectTimeoutMs = 600_000, callTimeoutMs = 180_000 } = {}) {
    Object.assign(this, { transport, connectTimeoutMs, callTimeoutMs });
  }

  async connect() {
    this.transport.start();
    const reply = await this.transport.rpc('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, this.connectTimeoutMs);
    if (reply.error) throw new Error(`initialize failed: ${reply.error.message}`);
    this.serverInfo = reply.result?.serverInfo;
    await this.transport.notify('notifications/initialized', {});
    return reply.result;
  }

  /** Returns { isError, data, text }: data is the parsed JSON text content when possible. */
  async callTool(name, args = {}) {
    const reply = await this.transport.rpc('tools/call', { name, arguments: args }, this.callTimeoutMs);
    if (reply.error) return { isError: true, data: undefined, text: reply.error.message ?? 'JSON-RPC error' };
    const text = (reply.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    let data;
    try { data = JSON.parse(text); } catch { data = undefined; }
    return { isError: Boolean(reply.result?.isError || data?.isError), data, text };
  }

  close() { return this.transport.close(); }
}

// ---- OAuth (MCP authorization: protected resource metadata, RFC 8414, RFC 7591, PKCE) ----

const b64url = buf => Buffer.from(buf).toString('base64url');

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!res.ok) return undefined;
  try { return await res.json(); } catch { return undefined; }
}

async function discover(fetchImpl, mcpUrl, wwwAuthenticate) {
  const mcp = new URL(mcpUrl);
  const prmCandidates = [];
  const m = /resource_metadata="([^"]+)"/.exec(wwwAuthenticate ?? '');
  if (m) prmCandidates.push(m[1]);
  prmCandidates.push(`${mcp.origin}/.well-known/oauth-protected-resource${mcp.pathname.replace(/\/$/, '')}`, `${mcp.origin}/.well-known/oauth-protected-resource`);
  let issuer = mcp.origin;
  for (const url of prmCandidates) {
    const prm = await getJson(fetchImpl, url);
    if (prm?.authorization_servers?.[0]) { issuer = prm.authorization_servers[0]; break; }
  }
  const as = new URL(issuer);
  const path = as.pathname.replace(/\/$/, '');
  for (const url of [`${as.origin}/.well-known/oauth-authorization-server${path}`, `${as.origin}/.well-known/openid-configuration${path}`, `${as.origin}${path}/.well-known/openid-configuration`]) {
    const meta = await getJson(fetchImpl, url);
    if (meta?.authorization_endpoint && meta?.token_endpoint) return meta;
  }
  throw new Error(`Could not discover OAuth authorization server metadata for ${mcpUrl}`);
}

function waitForCallback(server, state, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for the browser sign-in')), timeoutMs);
    server.on('request', (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' })
        .end(ok ? 'Signed in. You can close this tab and return to the terminal.' : 'Sign-in failed. Return to the terminal.');
      clearTimeout(timer);
      if (url.searchParams.get('error')) reject(new Error(`Authorization failed: ${url.searchParams.get('error')} ${url.searchParams.get('error_description') ?? ''}`.trim()));
      else if (url.searchParams.get('state') !== state) reject(new Error('Authorization failed: state mismatch'));
      else if (!url.searchParams.get('code')) reject(new Error('Authorization failed: no code returned'));
      else resolve(url.searchParams.get('code'));
    });
  });
}

/** Runs the browser OAuth flow against an MCP server and returns an access token (memory only). */
export async function oauthLogin({ mcpUrl, wwwAuthenticate, fetchImpl = fetch, onAuthorizeUrl, timeoutMs = 600_000 }) {
  const meta = await discover(fetchImpl, mcpUrl, wwwAuthenticate);
  if (meta.code_challenge_methods_supported && !meta.code_challenge_methods_supported.includes('S256')) throw new Error('Authorization server does not support PKCE S256');
  if (!meta.registration_endpoint) throw new Error('Authorization server offers no dynamic client registration; use --auth bearer or save the token in the DevPanel UI');

  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
    const regRes = await fetchImpl(meta.registration_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'DevPanel AI Toolkit helper', redirect_uris: [redirectUri], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
    });
    if (!regRes.ok) throw new Error(`Client registration failed (HTTP ${regRes.status})`);
    const client = await regRes.json();

    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(16));
    const auth = new URL(meta.authorization_endpoint);
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state, resource: mcpUrl })) auth.searchParams.set(k, v);

    const codePromise = waitForCallback(server, state, timeoutMs);
    await onAuthorizeUrl(auth.toString());
    const code = await codePromise;

    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier, resource: mcpUrl });
    if (client.client_secret) form.set('client_secret', client.client_secret);
    const tokRes = await fetchImpl(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString() });
    if (!tokRes.ok) throw new Error(`Token exchange failed (HTTP ${tokRes.status})`);
    const tokens = await tokRes.json();
    if (!tokens.access_token) throw new Error('Token exchange returned no access_token');
    return tokens.access_token;
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}

// ---- helpers ----

function parseSse(text) {
  const out = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    try { out.push(...[JSON.parse(data)].flat()); } catch { /* ignore non-JSON events */ }
  }
  return out;
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), ms); })]).finally(() => clearTimeout(timer));
}
