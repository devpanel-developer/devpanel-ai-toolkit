import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCRIPTS, fakeBin, fakeClassicPat, randomAlnum, run, tmp } from './helpers.mjs';

const node = (script, args, opts) => run(process.execPath, [join(SCRIPTS, script), ...args], opts);
const sha = () => Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

describe('server-config.mjs', () => {
  const base = ['--app-root', '/var/www/html', '--web-root', '/var/www/html/web'];

  test('maps a supported selection to explicit activation arguments', async () => {
    const r = await node('server-config.mjs', ['map', '--capacity', 'small_2', '--php', '8.3', '--mysql', 'cluster-default', '--storage', '10', '--drupal-major', '11', ...base]);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.activationArgs, { capacity: 'small_2', capacityLimit: 'small_2', containerImage: 'devpanel/php:8.3-base', appRoot: '/var/www/html', webRoot: '/var/www/html/web', storage: 10, copyDatabaseFilesType: '', isFromGit: true });
    assert.deepEqual([out.selection.cpu, out.selection.memory], ['0.5', '2GB']);
    assert.ok(!('mysql' in out.activationArgs), 'MySQL must never become an MCP argument');
  });

  test('a specific MySQL version needs cluster-level confirmation', async () => {
    const r = await node('server-config.mjs', ['map', '--capacity', 'small_2', '--php', '8.3', '--mysql', '8.0', ...base]);
    assert.equal(r.code, 3);
    assert.match(JSON.parse(r.stdout).issues.join(' '), /cannot be selected per application/);
    const ok = await node('server-config.mjs', ['map', '--capacity', 'small_2', '--php', '8.3', '--mysql', '8.0', '--mysql-confirmed', ...base]);
    assert.equal(ok.code, 0, ok.stdout);
    assert.equal(JSON.parse(ok.stdout).selection.mysql.confirmed, true);
  });

  for (const [name, args, code, pattern] of [
    ['PHP below the Drupal minimum', ['--capacity', 'small_2', '--php', '8.2', '--drupal-major', '11'], 3, /requires PHP >= 8\.3/],
    ['tier outside DevPanel listing', ['--capacity', 'large_2', '--php', '8.3'], 3, /not offered/],
    ['capacityLimit below capacity', ['--capacity', 'medium_1', '--capacity-limit', 'micro', '--php', '8.3'], 3, /below capacity/],
    ['MCP fallback image', ['--capacity', 'small_2', '--image', 'devpanel/php:8.3-base-rc'], 3, /generic fallback/],
    ['unknown tier', ['--capacity', 'huge', '--php', '8.3'], 2, /Unknown capacity tier/],
    ['unsupported PHP', ['--capacity', 'small_2', '--php', '7.2'], 2, /Unsupported PHP/],
    ['both --php and --image', ['--capacity', 'small_2', '--php', '8.3', '--image', 'x/y:1'], 2, /exactly one/],
  ]) {
    test(`flags ${name}`, async () => {
      const r = await node('server-config.mjs', ['map', ...args, '--mysql', 'cluster-default', ...base]);
      assert.equal(r.code, code, r.stdout + r.stderr);
      assert.match(r.stdout + r.stderr, pattern);
    });
  }

  test('roots are required and must be absolute', async () => {
    const r = await node('server-config.mjs', ['map', '--capacity', 'small_2', '--php', '8.3', '--mysql', 'cluster-default']);
    assert.equal(r.code, 2);
    const rel = await node('server-config.mjs', ['map', '--capacity', 'small_2', '--php', '8.3', '--mysql', 'cluster-default', '--app-root', 'html', '--web-root', '/var/www/html/web']);
    assert.equal(rel.code, 2);
  });

  test('over_commit forces capacityLimit large_1 as DevPanel does; custom images are allowed', async () => {
    const r = await node('server-config.mjs', ['map', '--capacity', 'over_commit', '--image', 'drupalforge/drupal_cms:main', '--mysql', 'cluster-default', ...base]);
    assert.equal(r.code, 0, r.stdout);
    const out = JSON.parse(r.stdout);
    assert.equal(out.activationArgs.capacityLimit, 'large_1');
    assert.equal(out.selection.php, 'image-defined');
  });

  test('options lists coupled tiers, PHP images and the MySQL constraint', async () => {
    const r = await node('server-config.mjs', ['options', '--project-type', 'drupal11_v2']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /small_2 +0\.5 CPU +2GB/);
    assert.match(r.stdout, /DevPanel default image for drupal11_v2: devpanel\/php:8\.3-base/);
    assert.match(r.stdout, /MySQL: DevPanel provisions the database from the workspace's environment/);
  });
});

describe('exec-record.mjs', () => {
  const env = () => ({ ...process.env, XDG_STATE_HOME: tmp('dpt-state-') });

  test('records IDs and steps outside the repository', async () => {
    const e = env();
    const init = await node('exec-record.mjs', ['init', '--workflow', 'create-branch-environment'], { env: e });
    assert.equal(init.code, 0, init.stderr);
    const path = init.stdout.trim();
    assert.ok(path.startsWith(join(e.XDG_STATE_HOME, 'dp-ai-toolkit', 'runs')));
    assert.equal((await node('exec-record.mjs', ['set', path, 'target.workspaceId=ws-1', 'target.branch=feature/x', 'resources.branch.created=true', 'resources.planHash=abc'], { env: e })).code, 0);
    assert.equal((await node('exec-record.mjs', ['add', path, 'activityIds', 'act-1'], { env: e })).code, 0);
    await node('exec-record.mjs', ['add', path, 'activityIds', 'act-1'], { env: e });
    const rec = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(rec.target.branch, 'feature/x');
    assert.equal(rec.resources.branch.created, true);
    assert.deepEqual(rec.activityIds, ['act-1'], 'duplicates are not added');
    assert.equal(rec.workflow, 'create-branch-environment');
  });

  for (const [what, args] of [
    ['a GitHub token value', path => ['add', path, 'notes', `saved ${fakeClassicPat()}`]],
    ['a fine-grained token', path => ['set', path, `target.note=github_pat_${randomAlnum(40)}`]],
    ['a credential key', path => ['set', path, 'target.dbPassword=hunter2']],
    ['a token key', path => ['set', path, 'resources.accessToken=x']],
    ['a signed backup URL', path => ['add', path, 'notes', 'https://bucket.example/db.tgz?X-Amz-Signature=abc&X-Amz-Credential=def']],
    ['a JWT', path => ['set', path, `target.x=eyJ${randomAlnum(20)}.${randomAlnum(30)}.${randomAlnum(20)}`]],
    ['URL credentials', path => ['set', path, `target.repo=https://user:${randomAlnum(12)}@github.com/o/r.git`]],
  ]) {
    test(`refuses ${what} without echoing it`, async () => {
      const e = env();
      const path = (await node('exec-record.mjs', ['init', '--workflow', 'diagnostics'], { env: e })).stdout.trim();
      const before = readFileSync(path, 'utf8');
      const a = args(path);
      const r = await node('exec-record.mjs', a, { env: e });
      assert.equal(r.code, 4, r.stderr);
      assert.equal(readFileSync(path, 'utf8'), before, 'record must be unchanged');
      const value = a.at(-1).split('=').slice(1).join('=') || a.at(-1);
      assert.ok(!r.stderr.includes(value) || value.length < 8, 'refusal must not echo the value');
    });
  }

  test('rejects unknown workflows and keys outside the schema', async () => {
    const e = env();
    assert.equal((await node('exec-record.mjs', ['init', '--workflow', 'nope'], { env: e })).code, 2);
    const path = (await node('exec-record.mjs', ['init', '--workflow', 'diagnostics'], { env: e })).stdout.trim();
    assert.equal((await node('exec-record.mjs', ['set', path, 'schemaVersion=9'], { env: e })).code, 2);
  });
});

describe('gh-branch.sh', () => {
  /** Fake gh: repository in $S/repo, refs in $S/ref-<branch with / as __>. */
  function fakeGh({ push = true, race } = {}) {
    const dir = tmp('dpt-gh-');
    const S = join(dir, 'state');
    mkdirSync(S);
    writeFileSync(join(S, 'repo'), JSON.stringify({ full_name: 'acme/site', private: true, default_branch: 'main', push, admin: false }));
    fakeBin(join(dir, 'bin'), 'gh', `
S="${S}"; echo "$*" >>"$S/log"
[[ $1 == api ]] || exit 2; shift
method=GET path='' fields=()
while [[ $# -gt 0 ]]; do case $1 in -X) method=$2; shift 2 ;; -f) fields+=("$2"); shift 2 ;; --jq) shift 2 ;; *) path=$1; shift ;; esac; done
reffile() { printf '%s/ref-%s' "$S" "$(printf %s "$1" | sed 's|/|__|g')"; }
case $path in
  repos/acme/site/git/ref/heads/*) f=$(reffile "\${path#repos/acme/site/git/ref/heads/}"); [[ -f $f ]] && cat "$f" || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; } ;;
  repos/acme/site/git/refs)
    for kv in "\${fields[@]}"; do case $kv in ref=*) ref=\${kv#ref=refs/heads/} ;; sha=*) sha=\${kv#sha=} ;; esac; done
    f=$(reffile "$ref")
    ${race ? `printf '%s' "${race}" >"$f"; echo "gh: Reference already exists (HTTP 422)" >&2; exit 1` : `[[ -f $f ]] && { echo "gh: Reference already exists (HTTP 422)" >&2; exit 1; }; printf '%s' "$sha" >"$f"; echo "$sha"`} ;;
  repos/acme/site) cat "$S/repo" ;;
  *) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
esac`);
    const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` };
    const gh = args => run('bash', [join(SCRIPTS, 'gh-branch.sh'), ...args], { env });
    return { S, gh, setRef: (b, s) => writeFileSync(join(S, `ref-${b.replace(/\//g, '__')}`), s), log: () => readFileSync(join(S, 'log'), 'utf8') };
  }

  test('lookup distinguishes existing, absent and inaccessible', async () => {
    const f = fakeGh();
    const s = sha();
    f.setRef('main', s);
    const found = await f.gh(['lookup', 'acme/site', 'main']);
    assert.equal(found.code, 0);
    assert.deepEqual(JSON.parse(found.stdout), { exists: true, branch: 'main', sha: s });
    const absent = await f.gh(['lookup', 'acme/site', 'feature/x']);
    assert.equal(absent.code, 1);
    assert.equal(JSON.parse(absent.stdout).exists, false);
    const noRepo = await f.gh(['lookup', 'acme/other', 'main']);
    assert.equal(noRepo.code, 2);
    assert.match(noRepo.stderr, /not found or not accessible/);
  });

  test('create uses the explicit SHA, reads it back and never forces', async () => {
    const f = fakeGh();
    const base = sha();
    f.setRef('main', base);
    const resolved = JSON.parse((await f.gh(['resolve-base', 'acme/site', 'main'])).stdout);
    assert.equal(resolved.sha, base);
    const created = await f.gh(['create', 'acme/site', 'feature/x', base]);
    assert.equal(created.code, 0, created.stderr);
    assert.deepEqual(JSON.parse(created.stdout), { created: true, exists: true, branch: 'feature/x', sha: base });
    const again = await f.gh(['create', 'acme/site', 'feature/x', sha()]);
    assert.equal(again.code, 0);
    assert.equal(JSON.parse(again.stdout).created, false);
    assert.equal(JSON.parse(again.stdout).sha, base, 'existing branch must not be moved');
    assert.ok(!/force/.test(f.log()));
    assert.equal(f.log().split('\n').filter(l => l.includes('-X POST')).length, 1, 'only one creation attempt');
  });

  test('a concurrently created branch is reported as found, with its actual SHA', async () => {
    const other = sha();
    const f = fakeGh({ race: other });
    const out = await f.gh(['create', 'acme/site', 'feature/y', sha()]);
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout), { created: false, exists: true, branch: 'feature/y', sha: other, matchesBase: false });
  });

  test('refuses branch names as base, invalid names and missing push permission', async () => {
    const f = fakeGh();
    assert.equal((await f.gh(['create', 'acme/site', 'feature/x', 'main'])).code, 2);
    assert.equal((await f.gh(['lookup', 'acme/site', 'bad..name'])).code, 2);
    assert.match((await fakeGh({ push: false }).gh(['create', 'acme/site', 'x', sha()])).stderr, /no push permission/);
    assert.equal((await f.gh(['resolve-base', 'acme/site', 'nope'])).code, 1);
  });
});

describe('check-site.sh', () => {
  async function site() {
    const server = createServer((req, res) => {
      const routes = {
        '/ok': [200, '<html>Welcome</html>'],
        '/drupal-error': [200, '<html>The website encountered an unexpected error. Try again later.</html>'],
        '/500': [500, 'boom'],
        '/auth': [401, 'auth'],
        '/404': [404, 'nope'],
      };
      if (req.url === '/') return res.writeHead(302, { location: '/core/install.php' }).end();
      if (req.url === '/core/install.php') return res.writeHead(200).end('Choose language');
      const [code, body] = routes[req.url] ?? [404, ''];
      res.writeHead(code, { 'content-type': 'text/html' }).end(body);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
  }

  test('classifies readiness beyond the status code', async () => {
    const s = await site();
    try {
      for (const [path, status, code] of [['/ok', 'ready', 0], ['/drupal-error', 'error_marker', 1], ['/500', 'server_error', 1], ['/auth', 'auth_protected', 1], ['/', 'install_required', 1], ['/404', 'not_found', 1]]) {
        const r = await run('bash', [join(SCRIPTS, 'check-site.sh'), `${s.base}${path}`, '--timeout', '5']);
        assert.equal(r.code, code, `${path}: ${r.stdout}${r.stderr}`);
        assert.equal(JSON.parse(r.stdout).status, status, path);
      }
    } finally { await s.close(); }
  });

  test('unreachable hosts are reported, retries are bounded', async () => {
    const r = await run('bash', [join(SCRIPTS, 'check-site.sh'), 'http://127.0.0.1:9/', '--retries', '1', '--interval', '0', '--timeout', '2']);
    assert.equal(r.code, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.status, 'unreachable');
    assert.equal(out.attempts, 2);
  });
});

describe('inspect-drupal-source.mjs', () => {
  test('reports versions, layout, suggestions, other deploy config and risks by path only', async () => {
    const d = tmp('dpt-drupal-');
    const password = randomAlnum(16);
    writeFileSync(join(d, 'composer.json'), JSON.stringify({ name: 'acme/site', require: { php: '>=8.1', 'drupal/core-recommended': '^10.3' }, extra: { 'drupal-scaffold': { locations: { 'web-root': 'web/' } } } }));
    writeFileSync(join(d, 'composer.lock'), JSON.stringify({ packages: [{ name: 'drupal/core', version: '10.3.1' }] }));
    mkdirSync(join(d, 'web', 'sites', 'default', 'files'), { recursive: true });
    writeFileSync(join(d, 'web', 'index.php'), '<?php');
    writeFileSync(join(d, 'web', 'sites', 'default', 'settings.php'), `<?php $databases['default']['default'] = ['password' => '${password}'];`);
    writeFileSync(join(d, 'backup.sql'), 'x');
    writeFileSync(join(d, '.env'), `DB_PASS=${password}`);
    mkdirSync(join(d, '.ddev'));
    const r = await node('inspect-drupal-source.mjs', [d]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes(password), 'file contents must never be printed');
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.drupal.major, 10);
    assert.equal(rep.drupal.version, '10.3.1');
    assert.equal(rep.layout.suggestedWebRoot, '/var/www/html/web');
    assert.equal(rep.suggestions.projectType, 'drupal10_v2');
    assert.equal(rep.suggestions.phpMinimum, '8.1');
    assert.deepEqual(rep.otherDeploymentConfig, ['.ddev']);
    assert.deepEqual(rep.risks.map(x => x.kind).sort(), ['database-dump', 'env-file', 'hardcoded-database-credentials']);
    assert.equal(rep.devpanel.present, false);
    assert.equal(rep.devpanel.productionTemplatePublished, false);
    assert.equal(rep.supported, true);
  });

  test('flags unsupported codebases as blockers', async () => {
    const d7 = tmp();
    mkdirSync(join(d7, 'includes'));
    writeFileSync(join(d7, 'includes', 'bootstrap.inc'), '');
    const r7 = JSON.parse((await node('inspect-drupal-source.mjs', [d7])).stdout);
    assert.equal(r7.supported, false);
    assert.match(r7.blockers.join(' '), /Drupal 7/);

    const noLock = tmp();
    writeFileSync(join(noLock, 'composer.json'), JSON.stringify({ require: { 'drupal/core-recommended': '^11' } }));
    const rn = JSON.parse((await node('inspect-drupal-source.mjs', [noLock])).stdout);
    assert.match(rn.blockers.join(' '), /composer\.lock is missing/);

    assert.equal((await node('inspect-drupal-source.mjs', [join(noLock, 'missing')])).code, 2);
    assert.ok(!existsSync(join(noLock, '.devpanel')), 'inspection must not create files');
  });
});
