#!/usr/bin/env node
// Direct DevPanel MCP helper for setup. It opens its OWN authenticated MCP
// connection -- it does not and cannot reuse Claude Code's MCP session -- and:
//   check          read-only: devpanel_whoami, devpanel_list_workspaces, devpanel_list_git_owners
//   set-git-token  reads a GitHub PAT classic via hidden terminal input (or a file
//                  descriptor) and sends it straight to devpanel_set_git_token
// The token never appears in arguments, environment, files or output. Run it in your
// own terminal; it refuses to run set-git-token inside a Claude Code session.
// Exit: 0 ok, 1 failed, 2 usage, 3 refused by a safety guard.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { AuthRequiredError, HttpTransport, McpClient, Redactor, oauthLogin } from './lib/mcp-client.mjs';

const USAGE = `Usage:
  dp-mcp-helper.mjs check         <connection> [--json]
  dp-mcp-helper.mjs set-git-token <connection> [--username <github-login>] [--skip-github-check] [--token-fd <n>]

Connection:
  --server-url <url> [--auth oauth|bearer] [--bearer-fd <n>] [--no-browser]
      DevPanel MCP server over HTTP (e.g. https://mcp.devpanel.com/mcp). oauth (default) signs
      in through your browser; bearer reads a static MCP bearer from --bearer-fd or hidden input.`;

class UsageError extends Error {}
class RefusedError extends Error {}
class AbortError extends Error {}

const redactor = new Redactor();
const say = text => process.stderr.write(`${redactor.scrub(text)}\n`);
const print = text => process.stdout.write(`${redactor.scrub(text)}\n`);

function parseArgs(argv) {
  const opts = { _: [] };
  const flags = new Set(['json', 'no-browser', 'skip-github-check']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { opts._.push(a); continue; }
    const key = a.slice(2);
    if (flags.has(key)) { opts[key] = true; continue; }
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`Missing value for --${key}`);
    opts[key] = v;
  }
  if (!opts['server-url']) throw new UsageError('--server-url is required');
  if (!/^https?:\/\/\S+$/.test(opts['server-url'])) throw new UsageError('--server-url must be an http(s) URL');
  if (opts.auth && !['oauth', 'bearer'].includes(opts.auth)) throw new UsageError('--auth must be oauth or bearer');
  for (const k of ['token-fd', 'bearer-fd']) if (opts[k] !== undefined && !/^\d+$/.test(opts[k])) throw new UsageError(`--${k} must be a file descriptor number`);
  return opts;
}

// ---- terminal input ----

/** Reads lines from stdin; hidden lines use raw mode on a TTY so nothing is echoed. */
class Input {
  #buf = ''; #ended = false; #wake = null;
  constructor(stream) {
    this.stream = stream;
    stream.setEncoding('utf8');
    stream.on('data', d => { this.#buf += d; this.#wake?.(); });
    stream.on('end', () => { this.#ended = true; this.#wake?.(); });
  }
  async #more() {
    if (this.#ended) return false;
    await new Promise(resolve => { this.#wake = resolve; });
    this.#wake = null;
    return true;
  }
  async line(prompt, { hidden = false } = {}) {
    if (hidden && !this.stream.isTTY) throw new RefusedError('Hidden input needs an interactive terminal. Run this in your own terminal (or pass --token-fd).');
    // Disable echo before showing the prompt, so input typed right away is never echoed.
    if (hidden) this.stream.setRawMode(true);
    process.stderr.write(prompt);
    this.stream.resume();
    let value = '';
    try {
      for (;;) {
        while (this.#buf.length > 0) {
          const c = this.#buf[0];
          this.#buf = this.#buf.slice(1);
          if (c === '\u0003') throw new AbortError('Cancelled.');
          if (c === '\r' || c === '\n') {
            if (c === '\r' && this.#buf[0] === '\n') this.#buf = this.#buf.slice(1);
            return value;
          }
          if (c === '\u007f' || c === '\b') { value = value.slice(0, -1); continue; }
          if (c === '\u0004' && value === '') throw new AbortError('Cancelled.');
          value += c;
        }
        if (!(await this.#more())) { if (value) return value; throw new AbortError('No input.'); }
      }
    } finally {
      if (hidden) { this.stream.setRawMode(false); process.stderr.write('\n'); }
      this.stream.pause();
    }
  }
  async confirm(question) {
    const answer = (await this.line(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  }
}

function readFd(fd) {
  const value = readFileSync(Number(fd), 'utf8').replace(/[\r\n]+$/, '');
  if (!value) throw new UsageError(`No data on file descriptor ${fd}`);
  return value;
}

// ---- connection ----

async function connect(opts, input) {
  const url = opts['server-url'];
  let token;
  if ((opts.auth ?? 'oauth') === 'bearer') {
    token = opts['bearer-fd'] ? readFd(opts['bearer-fd']) : await input.line('DevPanel MCP bearer token (input hidden): ', { hidden: true });
    redactor.add(token);
  }
  const client = new McpClient(new HttpTransport({ url, getToken: () => token }));
  try {
    await client.connect();
  } catch (error) {
    if (!(error instanceof AuthRequiredError)) throw error;
    if (opts.auth === 'bearer') throw new Error('The MCP server rejected the bearer token (HTTP 401).');
    say('The MCP server requires sign-in. Starting browser sign-in (OAuth, PKCE); the token stays in this process only.');
    token = await oauthLogin({
      mcpUrl: url, wwwAuthenticate: error.wwwAuthenticate,
      onAuthorizeUrl: async authUrl => {
        say(`\nOpen this URL in your browser to sign in to DevPanel MCP:\n  ${authUrl}\n`);
        if (!opts['no-browser']) openBrowser(authUrl);
      },
    });
    redactor.add(token);
    await client.connect();
  }
  return client;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try { spawn(cmd, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* print-only fallback */ }
}

// ---- DevPanel calls ----

function findProfile(data) {
  const pick = o => o && typeof o === 'object' ? o : undefined;
  const root = pick(data) ?? {};
  const candidates = [root, pick(root.user), pick(root.data), pick(root.profile)].filter(Boolean);
  const get = key => candidates.map(c => c[key]).find(v => typeof v === 'string' && v !== '');
  return {
    id: get('_id') ?? get('id'),
    email: get('email'),
    name: get('name') ?? get('fullName') ?? ([get('firstName'), get('lastName')].filter(Boolean).join(' ') || undefined),
    githubUsername: get('githubUsername'),
  };
}

async function whoami(client) {
  const r = await client.callTool('devpanel_whoami');
  if (r.isError) throw new Error(`devpanel_whoami failed: ${r.data?.message ?? r.text}`);
  return findProfile(r.data);
}

async function gitOwners(client) {
  const r = await client.callTool('devpanel_list_git_owners', { provider: 'GITHUB' });
  if (r.isError) return { ok: false, error: r.data?.message ?? r.text };
  const owners = Array.isArray(r.data) ? r.data.map(o => o.name || o.id).filter(Boolean) : [];
  return { ok: owners.length > 0, owners, error: owners.length === 0 ? 'no GitHub owners listed (PAT missing or lacks access)' : undefined };
}

async function check(opts, input) {
  const client = await connect(opts, input);
  try {
    const profile = await whoami(client);
    const ws = await client.callTool('devpanel_list_workspaces');
    const workspaces = !ws.isError && Array.isArray(ws.data) ? ws.data.map(w => ({ id: w.id, name: w.name })) : null;
    const git = await gitOwners(client);
    const result = {
      server: client.serverInfo?.name ?? null,
      identity: profile,
      githubUsernameSet: Boolean(profile.githubUsername),
      workspaces: workspaces ?? { error: ws.data?.message ?? ws.text },
      devpanelGit: git,
    };
    if (opts.json) { print(JSON.stringify(result, null, 2)); }
    else {
      print(`DevPanel identity:   ${profile.email ?? profile.id ?? 'unknown'}${profile.name ? ` (${profile.name})` : ''}`);
      print(`GitHub username:     ${profile.githubUsername ?? 'NOT SET (save a PAT classic: set-git-token, or DevPanel UI)'}`);
      print(`Workspaces:          ${workspaces ? `${workspaces.length} (${workspaces.map(w => w.name).join(', ')})` : `ERROR ${result.workspaces.error}`}`);
      print(`DevPanel Git (PAT):  ${git.ok ? `OK, owners: ${git.owners.join(', ')}` : `PROBLEM: ${git.error}${/bad credentials/i.test(git.error ?? '') ? ' -> replace the PAT' : ''}`}`);
    }
    return workspaces && git.ok && profile.githubUsername ? 0 : 1;
  } finally {
    await client.close();
  }
}

// ---- PAT ----

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

function classifyToken(token) {
  if (/^ghp_[A-Za-z0-9]{36}$/.test(token)) return 'classic';
  if (/^[0-9a-f]{40}$/.test(token)) return 'classic-legacy';
  if (token.startsWith('github_pat_')) throw new UsageError('This is a fine-grained token. DevPanel\'s Git integration requires a personal access token (classic).');
  if (/^gh[ousr]_/.test(token)) throw new UsageError('This is an OAuth/app token (for example from "gh auth token"), not a personal access token (classic). Create a PAT classic on GitHub.');
  throw new UsageError('This does not look like a GitHub personal access token (classic).');
}

async function checkWithGitHub(token) {
  const api = process.env.DP_TOOLKIT_GITHUB_API_URL || 'https://api.github.com';
  let res;
  try {
    res = await fetch(`${api}/user`, { headers: { authorization: `token ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'dp-ai-toolkit' } });
  } catch (error) {
    throw new Error(`Could not reach GitHub to check the token (${error.message}). Retry, or pass --skip-github-check.`);
  }
  if (res.status === 401) throw new Error('GitHub rejected the token (Bad credentials). Create a new PAT classic.');
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} while checking the token.`);
  const scopesHeader = res.headers.get('x-oauth-scopes');
  const body = await res.json();
  return { login: body.login, scopes: scopesHeader === null ? null : scopesHeader.split(',').map(s => s.trim()).filter(Boolean) };
}

async function setGitToken(opts, input) {
  if (process.env.CLAUDECODE) {
    throw new RefusedError('Refusing to run set-git-token inside a Claude Code session: the token must not pass through an AI session. Open a separate terminal and run this command there.');
  }
  if (opts.provider && opts.provider.toUpperCase() !== 'GITHUB') throw new UsageError('Only GitHub is supported (--provider GITHUB).');
  if (opts.username && !GITHUB_LOGIN.test(opts.username)) throw new UsageError(`"${opts.username}" is not a valid GitHub username.`);

  const client = await connect(opts, input);
  try {
    const profile = await whoami(client);
    say(`\nConnected as DevPanel user: ${profile.email ?? profile.id ?? 'unknown'}${profile.name ? ` (${profile.name})` : ''}`);
    say(`Current GitHub username in DevPanel: ${profile.githubUsername ?? 'not set'}`);
    if (!(await input.confirm('Is this your DevPanel account?'))) throw new AbortError('Stopped: wrong DevPanel identity. Nothing was changed.');

    let username = opts.username ?? profile.githubUsername;
    if (!username) username = (await input.line('GitHub username that owns the token: ')).trim();
    if (!GITHUB_LOGIN.test(username)) throw new UsageError(`"${username}" is not a valid GitHub username.`);

    const token = opts['token-fd'] ? readFd(opts['token-fd']) : await input.line('GitHub personal access token (classic) (input hidden): ', { hidden: true });
    redactor.add(token);
    const kind = classifyToken(token);
    if (kind === 'classic-legacy') say('Note: legacy 40-character classic token format.');

    if (!opts['skip-github-check']) {
      const gh = await checkWithGitHub(token);
      if (gh.scopes === null) throw new UsageError('GitHub reports no OAuth scopes for this token, so it is not a PAT classic.');
      say(`GitHub: token belongs to ${gh.login}; scopes: ${gh.scopes.join(', ') || '(none)'}`);
      if (!gh.scopes.includes('repo')) {
        say('Warning: the token lacks the "repo" scope; DevPanel cannot read private repositories or create repositories with it.');
        if (!(await input.confirm('Save it anyway?'))) throw new AbortError('Stopped. Nothing was changed.');
      }
      if (gh.login && gh.login.toLowerCase() !== username.toLowerCase()) {
        say(`Warning: the token belongs to "${gh.login}", not "${username}".`);
        if (!(await input.confirm(`Save it with username "${username}" anyway?`))) throw new AbortError('Stopped. Nothing was changed.');
      }
    } else {
      say('Skipping the GitHub token check (--skip-github-check).');
    }

    if (!(await input.confirm(`Save this PAT classic for GitHub user "${username}" to DevPanel account ${profile.email ?? profile.id ?? ''}?`))) {
      throw new AbortError('Stopped. Nothing was changed.');
    }
    const saved = await client.callTool('devpanel_set_git_token', { token, provider: 'GITHUB', username });
    if (saved.isError) throw new Error(`devpanel_set_git_token failed: ${saved.data?.message ?? saved.text}`);
    say('Saved in DevPanel. Verifying...');

    const after = await whoami(client);
    const git = await gitOwners(client);
    print(`GitHub username in DevPanel: ${after.githubUsername ?? 'still not set'}`);
    print(`DevPanel Git (PAT): ${git.ok ? `OK, owners: ${git.owners.join(', ')}` : `PROBLEM: ${git.error}`}`);
    return git.ok ? 0 : 1;
  } finally {
    await client.close();
  }
}

// ---- main ----

const input = new Input(process.stdin);
let code;
try {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '-h' || cmd === '--help') throw new UsageError('Missing command');
  const opts = parseArgs(rest);
  if (cmd === 'check') code = await check(opts, input);
  else if (cmd === 'set-git-token') code = await setGitToken(opts, input);
  else throw new UsageError(`Unknown command "${cmd}"`);
} catch (error) {
  if (error instanceof UsageError) { say(`error: ${error.message}\n\n${USAGE}`); code = 2; }
  else if (error instanceof RefusedError) { say(`refused: ${error.message}`); code = 3; }
  else if (error instanceof AbortError) { say(error.message); code = 1; }
  else { say(`error: ${error instanceof Error ? error.message : String(error)}`); code = 1; }
}
// Let stdout/stderr drain; force exit if a keep-alive handle lingers.
process.exitCode = code;
process.stdin.pause();
setTimeout(() => process.exit(code), 3000).unref();
