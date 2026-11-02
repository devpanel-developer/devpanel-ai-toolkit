// One-command installer (install.sh): option validation and a dry run that changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, cleanEnv, run, tmp } from './helpers.mjs';

const INSTALL = join(ROOT, 'install.sh');
const sh = (args, env = {}) => run('bash', [INSTALL, ...args], { cwd: ROOT, env: cleanEnv({ HOME: tmp('dpt-home-'), ...env }), input: '' });

test('--help describes the installer', async () => {
  const r = await sh(['--help']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /One-command installer/);
});

test('rejects an invalid scope, a non-https MCP URL and unknown options', async () => {
  assert.equal((await sh(['--scope', 'global'])).code, 64);
  assert.equal((await sh(['--mcp-url', 'http://insecure.example/mcp'])).code, 64);
  assert.equal((await sh(['--bogus'])).code, 64);
});

test('dry run from a checkout uses it, changes nothing and hands over to setup.sh', async () => {
  const dir = join(tmp('dpt-dir-'), 'toolkit');
  const r = await sh(['--dry-run', '--yes', '--dir', dir, '--mcp-url', 'https://mcp.example.test/mcp']);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /Using this checkout/);
  assert.match(r.stdout, /\(dry-run\) .*scripts\/setup\.sh --scope user .*--mcp-url https:\/\/mcp\.example\.test\/mcp/);
  assert.equal(existsSync(dir), false, 'dry run must not clone');
});
