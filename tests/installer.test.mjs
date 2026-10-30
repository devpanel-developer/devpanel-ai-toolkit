import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, cleanEnv, fakeBin, run, tmp } from './helpers.mjs';

const INSTALLER = join(ROOT, 'installers', 'install-claude-code.sh');
const VERSION = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
const REFERENCES = ['create-project-from-template.md', 'create-project-from-repository.md', 'create-branch-environment.md', 'sync-environment-data.md',
  'deploy-existing-site.md', 'devpanel-project-requirements.md', 'execution-and-verification.md'];

/** Sandbox with its own HOME and a fake `claude` that keeps MCP entries in $STATE. */
function sandbox() {
  const home = tmp('dpt-home-');
  const state = join(home, 'fake-claude');
  const bin = join(home, 'bin');
  mkdirSync(state, { recursive: true });
  fakeBin(bin, 'claude', `
STATE="${state}"
echo "$*" >>"$STATE/log"
case "$1 $2" in
  "--version "*) echo "9.9.9 (Claude Code)" ;;
  "auth status") echo '{"loggedIn": true, "authMethod": "claude.ai"}' ;;
  "mcp get") [[ -f "$STATE/mcp-$3" ]] || { echo "No MCP server found with name: $3" >&2; exit 1; }
             printf '%s:\\n  Scope: User config\\n  Status: ✔ Connected\\n  Type: http\\n  URL: %s\\n' "$3" "$(cat "$STATE/mcp-$3")" ;;
  "mcp add") shift 2; while [[ $1 == --* ]]; do shift 2; done; printf '%s' "$2" >"$STATE/mcp-$1" ;;
  *) exit 2 ;;
esac`);
  const env = cleanEnv({ HOME: home, PATH: `${bin}:${process.env.PATH}` });
  delete env.CLAUDE_CONFIG_DIR;
  const target = join(home, '.claude', 'skills', 'devpanel-project-lifecycle');
  const install = (args = [], opts = {}) => run('bash', [INSTALLER, ...args], { env: { ...env, ...opts.env }, cwd: opts.cwd ?? home });
  return { home, state, env, target, install, log: () => (existsSync(join(state, 'log')) ? readFileSync(join(state, 'log'), 'utf8') : '') };
}

const backups = dir => readdirSync(join(dir, '..')).filter(n => n.startsWith('devpanel-project-lifecycle.bak-'));

test('requires an explicit scope', async () => {
  const s = sandbox();
  const r = await s.install([]);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /--scope is required/);
  assert.ok(!existsSync(s.target));
});

test('user scope installs the skill, references, helpers, templates and bookkeeping', async () => {
  const s = sandbox();
  const r = await s.install(['--scope', 'user']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`Installed devpanel-project-lifecycle ${VERSION.replace(/\./g, '\\.')}`));
  for (const f of ['SKILL.md', 'VERSION', 'assets/server-config.json', 'templates/drupal/requirements.json', '.dp-ai-toolkit-manifest', '.dp-ai-toolkit-install.json', ...REFERENCES.map(n => `references/${n}`)]) {
    assert.ok(existsSync(join(s.target, f)), `missing ${f}`);
  }
  for (const f of ['gh-branch.sh', 'check-site.sh', 'server-config.mjs', 'exec-record.mjs', 'inspect-drupal-source.mjs']) accessSync(join(s.target, 'scripts', f), constants.X_OK);
  const info = JSON.parse(readFileSync(join(s.target, '.dp-ai-toolkit-install.json'), 'utf8'));
  assert.equal(info.version, VERSION);
  assert.equal(info.scope, 'user');
  assert.ok(!s.log().includes('mcp add'), 'MCP must not be configured unless asked');
});

test('installed helpers run from the installed location', async () => {
  const s = sandbox();
  await s.install(['--scope', 'user']);
  const opts = await run(process.execPath, [join(s.target, 'scripts', 'server-config.mjs'), 'options', '--json']);
  assert.equal(opts.code, 0, opts.stderr);
  const proj = tmp();
  writeFileSync(join(proj, 'composer.json'), JSON.stringify({ require: { 'drupal/core-recommended': '^11.1' }, extra: { 'drupal-scaffold': { locations: { 'web-root': 'web/' } } } }));
  const insp = await run(process.execPath, [join(s.target, 'scripts', 'inspect-drupal-source.mjs'), proj]);
  const report = JSON.parse(insp.stdout);
  assert.equal(report.devpanel.productionTemplatePublished, false, 'requirements manifest must be found in the installed templates/');
});

test('re-running is repeatable and updates in place without backups', async () => {
  const s = sandbox();
  await s.install(['--scope', 'user']);
  const r = await s.install(['--scope', 'user']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`Updated .* \\(${VERSION.replace(/\./g, '\\.')} -> `));
  assert.equal(backups(s.target).length, 0);
  assert.ok(!readdirSync(join(s.target, '..')).some(n => n.includes('.staging.') || n.includes('.old.')), 'temporary directories left behind');
});

test('local modifications are protected; --force keeps a backup', async () => {
  const s = sandbox();
  await s.install(['--scope', 'user']);
  appendFileSync(join(s.target, 'SKILL.md'), '\nlocal note\n');
  const refused = await s.install(['--scope', 'user']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /SKILL\.md/);
  assert.match(readFileSync(join(s.target, 'SKILL.md'), 'utf8'), /local note/, 'modified file must be untouched');

  const forced = await s.install(['--scope', 'user', '--force']);
  assert.equal(forced.code, 0, forced.stderr);
  const [bak] = backups(s.target);
  assert.ok(bak, 'backup expected');
  assert.match(readFileSync(join(s.target, '..', bak, 'SKILL.md'), 'utf8'), /local note/);
  assert.doesNotMatch(readFileSync(join(s.target, 'SKILL.md'), 'utf8'), /local note/);
});

test('an existing skill directory not installed by the toolkit is never overwritten without --force', async () => {
  const s = sandbox();
  mkdirSync(s.target, { recursive: true });
  writeFileSync(join(s.target, 'SKILL.md'), 'someone else\n');
  const r = await s.install(['--scope', 'user']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not installed by this toolkit/);
  assert.equal(readFileSync(join(s.target, 'SKILL.md'), 'utf8'), 'someone else\n');
});

test('--dry-run changes nothing', async () => {
  const s = sandbox();
  const r = await s.install(['--scope', 'user', '--dry-run', '--configure-mcp', 'https://mcp.example.test/mcp']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\[dry-run\] would install/);
  assert.match(r.stdout, /\[dry-run\] would run: claude mcp add/);
  assert.ok(!existsSync(join(s.home, '.claude')));
  assert.ok(!s.log().includes('mcp add'));
});

test('project scope installs under the project and defaults MCP to local scope', async () => {
  const s = sandbox();
  const proj = tmp('dpt-proj-');
  const r = await s.install(['--scope', 'project', '--project-dir', proj, '--configure-mcp', 'https://mcp.example.test/mcp']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(join(proj, '.claude', 'skills', 'devpanel-project-lifecycle', 'SKILL.md')));
  assert.ok(!existsSync(s.target));
  assert.match(s.log(), /mcp add --transport http --scope local devpanel https:\/\/mcp\.example\.test\/mcp/);
});

test('CLAUDE_CONFIG_DIR is respected for user scope', async () => {
  const s = sandbox();
  const cfg = tmp('dpt-cfg-');
  const r = await s.install(['--scope', 'user'], { env: { CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(join(cfg, 'skills', 'devpanel-project-lifecycle', 'SKILL.md')));
});

test('MCP registration never changes an existing entry', async () => {
  const s = sandbox();
  writeFileSync(join(s.state, 'mcp-devpanel'), 'https://other.example.test/mcp');
  const r = await s.install(['--scope', 'user', '--configure-mcp', 'https://mcp.example.test/mcp']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /already exists with URL https:\/\/other\.example\.test\/mcp; not changing it/);
  assert.equal(readFileSync(join(s.state, 'mcp-devpanel'), 'utf8'), 'https://other.example.test/mcp');
  assert.ok(!s.log().includes('mcp add'));

  writeFileSync(join(s.state, 'mcp-devpanel'), 'https://mcp.example.test/mcp');
  const same = await s.install(['--scope', 'user', '--configure-mcp', 'https://mcp.example.test/mcp']);
  assert.equal(same.code, 0, same.stderr);
  assert.match(same.stdout, /already configured/);
});

test('MCP registration uses user scope by default and rejects non-https URLs', async () => {
  const s = sandbox();
  const r = await s.install(['--scope', 'user', '--configure-mcp', 'https://mcp.example.test/mcp']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(s.log(), /mcp add --transport http --scope user devpanel https:\/\/mcp\.example\.test\/mcp/);
  const bad = await s.install(['--scope', 'user', '--configure-mcp', 'http://mcp.example.test/mcp', '--mcp-name', 'other']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /needs an https:\/\/ URL/);
});

test('uninstall removes an unmodified install and protects a modified one', async () => {
  const s = sandbox();
  const none = await s.install(['--scope', 'user', '--uninstall']);
  assert.equal(none.code, 0);
  assert.match(none.stdout, /Not installed/);

  await s.install(['--scope', 'user']);
  appendFileSync(join(s.target, 'references', 'create-branch-environment.md'), 'edit\n');
  const refused = await s.install(['--scope', 'user', '--uninstall']);
  assert.equal(refused.code, 1);
  assert.ok(existsSync(s.target));

  await s.install(['--scope', 'user', '--force']);
  const removed = await s.install(['--scope', 'user', '--uninstall']);
  assert.equal(removed.code, 0, removed.stderr);
  assert.ok(!existsSync(s.target));
  assert.match(removed.stdout, /MCP configuration was not changed/);
});
