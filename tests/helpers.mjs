// Shared test utilities. Tokens used in tests are random synthetic values created at
// runtime, so no token-shaped literal is ever committed to the repository.
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SKILL_DIR = join(ROOT, 'skills', 'devpanel-project-lifecycle');
export const SCRIPTS = join(SKILL_DIR, 'scripts');
export const FIXTURES = join(ROOT, 'tests', 'fixtures');

export const tmp = (prefix = 'dpt-') => mkdtempSync(join(tmpdir(), prefix));

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export function randomAlnum(n) {
  const bytes = randomBytes(n);
  return Array.from(bytes, b => ALNUM[b % ALNUM.length]).join('');
}
export const fakeClassicPat = () => `ghp_${randomAlnum(36)}`;

/** Environment without Claude Code session markers (the helper refuses to run inside one). */
export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
  return { ...env, ...extra };
}

/** Runs a command; resolves { code, stdout, stderr }. extraFds: { 3: 'data', 4: 'data' } piped in. */
export function run(cmd, args, { cwd, env, input, extraFds = {}, timeoutMs = 60_000, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const fdNums = Object.keys(extraFds).map(Number);
    const maxFd = fdNums.length ? Math.max(...fdNums) : 2;
    const stdio = ['pipe', 'pipe', 'pipe'];
    for (let fd = 3; fd <= maxFd; fd++) stdio.push(fdNums.includes(fd) ? 'pipe' : 'ignore');
    const child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; onStderr?.(String(d), child); });
    // A child may exit (e.g. refuse) without reading its input; that is not a test error.
    for (const s of [child.stdin, ...fdNums.map(fd => child.stdio[fd])]) s.on('error', () => {});
    for (const fd of fdNums) { child.stdio[fd].end(extraFds[fd]); }
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timeout: ${cmd} ${args.join(' ')}\n${stderr}`)); }, timeoutMs);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** Creates an executable fake command in dir. */
export function fakeBin(dir, name, script) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}
