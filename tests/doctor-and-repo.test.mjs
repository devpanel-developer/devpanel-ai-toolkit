import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, SKILL_DIR, cleanEnv, fakeBin, randomAlnum, run, tmp } from './helpers.mjs';

describe('doctor.sh', () => {
  function env({ mcpStatus = '✔ Connected', ghAuthed = true, loggedIn = true, secret = 'none' } = {}) {
    const home = tmp('dpt-doc-');
    const bin = join(home, 'bin');
    fakeBin(bin, 'claude', `
case "$1 $2" in
  "--version "*) echo "9.9.9 (Claude Code)" ;;
  "auth status") echo '{"loggedIn": ${loggedIn}, "authMethod": "claude.ai", "email": "someone@example.test"}' ;;
  "mcp get") printf 'devpanel:\\n  Scope: User config\\n  Status: ${mcpStatus}\\n  Type: http\\n  URL: https://mcp.example.test/mcp\\n  Headers:\\n    Authorization: Bearer ${secret}\\n' ;;
  "mcp add") ;;
esac`);
    fakeBin(bin, 'gh', `
case "$1 $2" in
  "auth status") ${ghAuthed ? 'exit 0' : 'exit 1'} ;;
  "api user") echo octocat ;;
  "--version ") echo "gh version 9" ;;
esac`);
    const e = cleanEnv({ HOME: home, PATH: `${bin}:${process.env.PATH}` });
    delete e.CLAUDE_CONFIG_DIR;
    return { home, e };
  }
  const doctor = (e, cwd) => run('bash', [join(ROOT, 'scripts', 'doctor.sh'), '--project-dir', cwd], { env: e, cwd });

  test('all prerequisites present: no failures, DevPanel identity check explained', async () => {
    const { home, e } = env();
    await run('bash', [join(ROOT, 'installers', 'install-claude-code.sh'), '--scope', 'user'], { env: e, cwd: home });
    const r = await doctor(e, home);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /OK +logged in \(claude\.ai\)/);
    assert.match(r.stdout, /OK +.*devpanel-project-lifecycle \(version \d+\.\d+\.\d+, unmodified\)/);
    assert.match(r.stdout, /OK +connected/);
    assert.match(r.stdout, /OK +gh authenticated as octocat/);
    assert.match(r.stdout, /Claude Code's MCP login is not available to scripts/);
    assert.doesNotMatch(r.stdout, /someone@example\.test/, 'account email is not printed');
  });

  test('reports each missing prerequisite separately', async () => {
    const { home, e } = env({ mcpStatus: '! Needs authentication', ghAuthed: false, loggedIn: false });
    const r = await doctor(e, home);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /FAIL +Claude Code is not logged in/);
    assert.match(r.stdout, /FAIL +skill not installed/);
    assert.match(r.stdout, /WARN +configured but not authenticated: in Claude Code run \/mcp/);
    assert.match(r.stdout, /FAIL +gh is not authenticated/);
  });

  test('never prints MCP header values', async () => {
    const secret = randomAlnum(40);
    const { home, e } = env({ secret });
    const r = await doctor(e, home);
    assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret));
  });
});

describe('repository hygiene', () => {
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (name === '.git' || name === 'node_modules') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full); else files.push(full);
    }
  })(ROOT);

  test('no credential-shaped strings are committed', () => {
    const patterns = [/\bgh[pousr]_[A-Za-z0-9]{36}\b/, /\bgithub_pat_[A-Za-z0-9_]{50,}/, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const p of patterns) assert.ok(!p.test(text), `${relative(ROOT, f)} matches ${p}`);
    }
  });

  test('SKILL.md frontmatter, size and routing to every reference', () => {
    const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1];
    assert.ok(fm, 'frontmatter missing');
    assert.match(fm, /^name: devpanel-project-lifecycle$/m);
    const description = /^description: (.+)$/m.exec(fm)?.[1] ?? '';
    assert.ok(description.length > 50 && description.length <= 1024, 'description length');
    assert.ok(skill.split('\n').length < 150, 'SKILL.md should stay concise');
    const refs = readdirSync(join(SKILL_DIR, 'references'));
    assert.deepEqual(refs.sort(), ['create-branch-environment.md', 'create-project-from-repository.md', 'create-project-from-template.md', 'deploy-existing-site.md', 'devpanel-project-requirements.md', 'execution-and-verification.md', 'sync-environment-data.md']);
    for (const r of refs) assert.ok(skill.includes(`references/${r}`), `SKILL.md does not route to ${r}`);
  });

  test('every helper referenced by the skill exists', () => {
    const docs = [join(SKILL_DIR, 'SKILL.md'), ...readdirSync(join(SKILL_DIR, 'references')).map(n => join(SKILL_DIR, 'references', n))];
    for (const d of docs) {
      for (const [, script] of readFileSync(d, 'utf8').matchAll(/\$\{CLAUDE_SKILL_DIR\}\/scripts\/([\w.-]+)/g)) {
        assert.ok(existsSync(join(SKILL_DIR, 'scripts', script)), `${relative(ROOT, d)} references missing scripts/${script}`);
      }
    }
  });

  test('shell scripts parse', () => {
    for (const f of files.filter(f => f.endsWith('.sh'))) execFileSync('bash', ['-n', f]);
  });

  test('no references to internal source repositories', () => {
    // Built from parts so this test file does not match itself.
    const internal = new RegExp(['dp' + 'mcp', 'devpanel-' + 'api-v2', 'e8b' + '456e', '5c3' + '00877'].join('|'), 'i');
    for (const f of files) {
      assert.doesNotMatch(readFileSync(f, 'utf8'), internal, relative(ROOT, f));
    }
  });
});

// Makes sure a stray fixture directory never ends up in the repository.
test('tests leave no files in the repository', () => {
  const stray = readdirSync(ROOT).filter(n => n.startsWith('.devpanel-project-lifecycle') || n.endsWith('.bak') || n === '.devpanel-runs');
  assert.deepEqual(stray, []);
});
