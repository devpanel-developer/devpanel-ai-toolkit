import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { FIXTURES, ROOT, cleanEnv, fakeClassicPat, randomAlnum, run } from './helpers.mjs';

const HELPER = join(ROOT, 'scripts', 'dp-mcp-helper.mjs');

function helper(args, { env = {}, input, extraFds, onStderr } = {}) {
  return run(process.execPath, [HELPER, ...args], { env: cleanEnv(env), input, extraFds, onStderr });
}

// ---- fake DevPanel MCP HTTP server: MCP OAuth (DCR + PKCE) and/or a static bearer ----

async function body(req) { let b = ''; for await (const c of req) b += c; return b; }
const sendJson = (res, value, status = 200, headers = {}) => res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(value));

/** leaky: the server echoes the received token in its error, to prove the helper redacts it. */
async function startFakeMcp({ bearer, githubUsername = 'tester', leaky = false } = {}) {
  const st = { calls: [], codes: new Map(), tokens: new Set(), redirect: undefined };
  const server = createServer(async (req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(req.url, base);
    const raw = await body(req);
    switch (url.pathname) {
      case '/.well-known/oauth-protected-resource/mcp': return sendJson(res, { resource: `${base}/mcp`, authorization_servers: [`${base}/`] });
      case '/.well-known/oauth-authorization-server': return sendJson(res, { issuer: `${base}/`, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, code_challenge_methods_supported: ['S256'] });
      case '/register': { const r = JSON.parse(raw); st.redirect = r.redirect_uris[0]; return sendJson(res, { ...r, client_id: 'client-1' }, 201); }
      case '/authorize': {
        const p = url.searchParams;
        if (p.get('client_id') !== 'client-1' || p.get('redirect_uri') !== st.redirect || p.get('code_challenge_method') !== 'S256') return res.writeHead(400).end();
        const code = `code-${randomAlnum(8)}`;
        st.codes.set(code, p.get('code_challenge'));
        return res.writeHead(302, { location: `${st.redirect}?code=${code}&state=${encodeURIComponent(p.get('state'))}` }).end();
      }
      case '/token': {
        const f = new URLSearchParams(raw);
        const challenge = st.codes.get(f.get('code'));
        const ok = challenge && createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') === challenge;
        if (!ok) return sendJson(res, { error: 'invalid_grant' }, 400);
        const at = `at-${randomAlnum(24)}`;
        st.tokens.add(at);
        st.issued = at;
        return sendJson(res, { access_token: at, token_type: 'Bearer', expires_in: 3600 });
      }
      case '/mcp': {
        const auth = req.headers.authorization ?? '';
        const valid = st.tokens.has(auth.replace(/^Bearer /, '')) || (bearer && auth === `Bearer ${bearer}`);
        if (!valid) return res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }).end();
        if (req.method === 'DELETE') return res.writeHead(200).end();
        const msg = JSON.parse(raw);
        if (msg.id === undefined) return res.writeHead(202).end();
        if (msg.method === 'initialize') return sendJson(res, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: {}, serverInfo: { name: 'fake-http' } } }, 200, { 'mcp-session-id': 'sess-1' });
        const { name, arguments: args } = msg.params;
        st.calls.push({ tool: name, args, session: req.headers['mcp-session-id'] });
        let result;
        if (name === 'devpanel_set_git_token' && leaky) {
          result = { content: [{ type: 'text', text: JSON.stringify({ isError: true, message: `rejected ${args.token}` }) }], isError: true };
        } else {
          const data = {
            devpanel_whoami: { email: 'tester@example.test', name: 'Test User', ...(githubUsername ? { githubUsername } : {}) },
            devpanel_list_workspaces: [{ id: 'ws-1', name: 'WS' }],
            devpanel_list_git_owners: [{ id: 'o', name: 'tester' }],
            devpanel_set_git_token: { status: 'ok' },
          }[name];
          result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
        }
        // Tool replies as SSE, initialize as JSON: the client must handle both.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
      }
      default: return res.writeHead(404).end();
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  return { st, url, bearerConn: ['--server-url', url, '--auth', 'bearer', '--bearer-fd', '4'], setCalls: () => st.calls.filter(c => c.tool === 'devpanel_set_git_token'), close: () => new Promise(r => server.close(r)) };
}

async function startFakeGitHub({ token, scopes, login }) {
  const server = createServer((req, res) => {
    if (req.url !== '/user' || req.headers.authorization !== `token ${token}`) return res.writeHead(401).end('{"message":"Bad credentials"}');
    res.writeHead(200, { 'content-type': 'application/json', 'x-oauth-scopes': scopes }).end(JSON.stringify({ login }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}

/** Runs set-git-token with bearer on fd 4 and the PAT on fd 3 against a fresh fake server. */
async function withServer(opts, fn) {
  const bearer = randomAlnum(32);
  const fake = await startFakeMcp({ bearer, ...opts });
  try { return await fn(fake, bearer); } finally { await fake.close(); }
}

test('requires an http(s) --server-url', async () => {
  assert.equal((await helper(['check'])).code, 2);
  assert.equal((await helper(['check', '--server-url', 'ftp://x'])).code, 2);
});

test('set-git-token refuses to run inside a Claude Code session', () => withServer({}, async (fake, bearer) => {
  const r = await run(process.execPath, [HELPER, 'set-git-token', '--username', 'tester', '--token-fd', '3', ...fake.bearerConn],
    { env: { ...cleanEnv(), CLAUDECODE: '1' }, extraFds: { 3: fakeClassicPat(), 4: bearer } });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /inside a Claude Code session/);
  assert.equal(fake.st.calls.length, 0, 'no MCP call may happen');
}));

test('token from a file descriptor reaches devpanel_set_git_token and never the output', () => withServer({}, async (fake, bearer) => {
  const token = fakeClassicPat();
  const r = await helper(['set-git-token', '--username', 'tester', '--skip-github-check', '--token-fd', '3', ...fake.bearerConn], { input: 'y\ny\n', extraFds: { 3: `${token}\n`, 4: bearer } });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fake.setCalls()[0].args, { token, provider: 'GITHUB', username: 'tester' });
  for (const s of [token, bearer]) assert.ok(!r.stdout.includes(s) && !r.stderr.includes(s), 'secret leaked to output');
}));

test('a server that echoes the token is redacted', () => withServer({ leaky: true }, async (fake, bearer) => {
  const token = fakeClassicPat();
  const r = await helper(['set-git-token', '--username', 'tester', '--skip-github-check', '--token-fd', '3', ...fake.bearerConn], { input: 'y\ny\n', extraFds: { 3: token, 4: bearer } });
  assert.equal(r.code, 1);
  assert.ok(!r.stdout.includes(token) && !r.stderr.includes(token), 'token leaked to output');
  assert.match(r.stderr, /\[REDACTED\]/);
}));

for (const [kind, token, pattern] of [
  ['fine-grained', () => `github_pat_${randomAlnum(22)}_${randomAlnum(59)}`, /fine-grained/],
  ['gh OAuth', () => `gho_${randomAlnum(36)}`, /OAuth\/app token/],
  ['arbitrary', () => randomAlnum(30), /does not look like/],
]) {
  test(`rejects a ${kind} token before calling devpanel_set_git_token`, () => withServer({}, async (fake, bearer) => {
    const value = token();
    const r = await helper(['set-git-token', '--username', 'tester', '--skip-github-check', '--token-fd', '3', ...fake.bearerConn], { input: 'y\ny\n', extraFds: { 3: value, 4: bearer } });
    assert.equal(r.code, 2);
    assert.match(r.stderr, pattern);
    assert.equal(fake.setCalls().length, 0);
    assert.ok(!r.stderr.includes(value));
  }));
}

test('hidden input is required when no token fd is given and stdin is not a terminal', () => withServer({}, async (fake, bearer) => {
  const r = await helper(['set-git-token', '--username', 'tester', ...fake.bearerConn], { input: 'y\n', extraFds: { 4: bearer } });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /interactive terminal/);
  assert.equal(fake.setCalls().length, 0);
}));

test('declining the DevPanel identity stops before any token is read', () => withServer({}, async (fake, bearer) => {
  const r = await helper(['set-git-token', '--username', 'tester', '--skip-github-check', '--token-fd', '3', ...fake.bearerConn], { input: 'n\n', extraFds: { 3: fakeClassicPat(), 4: bearer } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /wrong DevPanel identity/);
  assert.equal(fake.setCalls().length, 0);
}));

let hasPython = true;
try { execFileSync('python3', ['-c', 'import pty']); } catch { hasPython = false; }

test('hidden terminal input: neither the bearer nor the token is echoed', { skip: !hasPython && 'python3 not available' }, async () => {
  // The PTY driver answers every hidden prompt with the same secret, so the fake server
  // accepts that value as the bearer and the helper sends it as the PAT.
  const token = fakeClassicPat();
  const fake = await startFakeMcp({ bearer: token });
  try {
    const r = await run('python3', ['-I', join(FIXTURES, 'pty-drive.py'), process.execPath, HELPER, 'set-git-token', '--username', 'tester', '--skip-github-check', '--server-url', fake.url, '--auth', 'bearer'],
      { env: cleanEnv({ PTY_SECRET: token }) });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /\(input hidden\)/);
    assert.ok(!r.stdout.includes(token), 'secret was echoed to the terminal');
    assert.equal(fake.setCalls()[0]?.args.token, token);
  } finally { await fake.close(); }
});

test('OAuth: helper signs in on its own (DCR + PKCE) and runs read-only checks', async () => {
  const fake = await startFakeMcp();
  let seen = '';
  let followed = false;
  try {
    const r = await helper(['check', '--server-url', fake.url, '--no-browser'], {
      onStderr: async chunk => {
        const m = /(http:\/\/127\.0\.0\.1:\d+\/authorize\?\S+)/.exec(seen += chunk);
        if (m && !followed) { followed = true; await fetch(m[1]); } // the "browser": follows the redirect to the loopback callback
      },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /tester@example\.test/);
    assert.match(r.stdout, /GitHub username: +tester/);
    assert.ok(fake.st.issued && !r.stdout.includes(fake.st.issued) && !r.stderr.includes(fake.st.issued), 'access token leaked');
    assert.deepEqual(fake.st.calls.map(c => c.tool), ['devpanel_whoami', 'devpanel_list_workspaces', 'devpanel_list_git_owners']);
    assert.ok(fake.st.calls.every(c => c.session === 'sess-1'));
  } finally { await fake.close(); }
});

test('check reports a missing GitHub username in DevPanel', () => withServer({ githubUsername: null }, async (fake, bearer) => {
  const r = await helper(['check', ...fake.bearerConn], { extraFds: { 4: bearer } });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /GitHub username: +NOT SET/);
}));

test('token checked with GitHub (classic scopes) and saved', () => withServer({}, async (fake, bearer) => {
  const token = fakeClassicPat();
  const gh = await startFakeGitHub({ token, scopes: 'repo, workflow', login: 'tester' });
  try {
    const r = await helper(['set-git-token', '--token-fd', '3', ...fake.bearerConn], { env: { DP_TOOLKIT_GITHUB_API_URL: gh.url }, input: 'y\ny\n', extraFds: { 3: token, 4: bearer } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /token belongs to tester; scopes: repo, workflow/);
    assert.deepEqual(fake.setCalls()[0].args, { token, provider: 'GITHUB', username: 'tester' });
    for (const s of [token, bearer]) assert.ok(!r.stdout.includes(s) && !r.stderr.includes(s), 'secret leaked');
  } finally { await gh.close(); }
}));

test('token without the repo scope is not saved unless the user insists', () => withServer({}, async (fake, bearer) => {
  const token = fakeClassicPat();
  const gh = await startFakeGitHub({ token, scopes: 'read:user', login: 'tester' });
  try {
    const r = await helper(['set-git-token', '--token-fd', '3', ...fake.bearerConn], { env: { DP_TOOLKIT_GITHUB_API_URL: gh.url }, input: 'y\nn\n', extraFds: { 3: token, 4: bearer } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /lacks the "repo" scope/);
    assert.equal(fake.setCalls().length, 0);
  } finally { await gh.close(); }
}));

test('a rejected bearer fails without falling back to OAuth', () => withServer({}, async fake => {
  const r = await helper(['check', ...fake.bearerConn], { extraFds: { 4: randomAlnum(32) } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /rejected the bearer token/);
}));
