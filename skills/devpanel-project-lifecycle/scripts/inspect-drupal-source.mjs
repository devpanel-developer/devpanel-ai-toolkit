#!/usr/bin/env node
// Read-only inspection of a local Drupal codebase for DevPanel deployment. Never
// modifies the source and
// never prints file contents; risks are reported by path only.
//   inspect-drupal-source.mjs <path> [--pretty]
// Exit: 0 inspected (see "blockers"), 2 usage / unreadable path.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const firstExisting = paths => paths.find(p => existsSync(p));
const REQUIREMENTS_PATH = firstExisting([join(HERE, '..', 'templates', 'drupal', 'requirements.json'), join(HERE, '..', '..', '..', 'templates', 'drupal', 'requirements.json')]);
const SERVER_CONFIG = JSON.parse(readFileSync(join(HERE, '..', 'assets', 'server-config.json'), 'utf8'));

const SKIP_DIRS = new Set(['.git', 'vendor', 'node_modules', 'core', 'contrib', 'libraries', '.idea', '.vscode']);
const DUMP_FILE = /\.(sql|sql\.gz|sql\.tgz|sql\.zip|sql\.bz2|mysql|dump)$/i;
const OTHER_DEPLOY = ['.ddev', '.lando.yml', '.lando.yaml', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml', 'Dockerfile',
  '.platform.app.yaml', '.platform', 'pantheon.yml', 'pantheon.upstream.yml', 'hooks', '.github/workflows', '.gitlab-ci.yml', 'bitbucket-pipelines.yml', '.tugboat', '.circleci'];

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

function git(root, args) {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return undefined; }
}

function walk(root, maxDepth, visit) {
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(dir, e.name);
      visit(full, e);
      if (e.isDirectory() && depth < maxDepth && !SKIP_DIRS.has(e.name)) stack.push([full, depth + 1]);
    }
  }
}

function majorFrom(constraint) {
  const m = /(\d+)(?:\.\d+)*/.exec(constraint ?? '');
  return m ? Number(m[1]) : undefined;
}

export function inspect(root) {
  const report = { path: root, git: {}, composer: { present: false }, drupal: {}, layout: {}, suggestions: {}, devpanel: { present: false, items: [] }, otherDeploymentConfig: [], risks: [], blockers: [], notes: [] };

  // Git state (read-only).
  const inside = git(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
  report.git = inside
    ? { isRepo: true, branch: git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), head: git(root, ['rev-parse', 'HEAD']), dirty: (git(root, ['status', '--porcelain']) ?? '') !== '' }
    : { isRepo: false };
  const tracked = rel => inside && (git(root, ['ls-files', '--', rel]) ?? '') !== '';

  // Composer.
  const composer = readJson(join(root, 'composer.json'));
  const lock = readJson(join(root, 'composer.lock'));
  if (composer) {
    const req = composer.require ?? {};
    const corePackage = ['drupal/core-recommended', 'drupal/core', 'drupal/cms'].find(p => req[p]);
    const lockedCore = lock?.packages?.find(p => p.name === 'drupal/core');
    report.composer = {
      present: true, lockPresent: Boolean(lock), name: composer.name,
      corePackage: corePackage ?? null, coreConstraint: corePackage ? req[corePackage] : null,
      coreLocked: lockedCore?.version ?? null,
      phpConstraint: req.php ?? null, platformPhp: composer.config?.platform?.php ?? null,
      webRootSetting: composer.extra?.['drupal-scaffold']?.locations?.['web-root'] ?? null,
    };
    if (!lock) report.blockers.push('composer.lock is missing: the deployed versions are not reproducible. Ask the user to commit a lock file.');
    if (!corePackage && !lockedCore) report.blockers.push('composer.json does not require drupal/core, drupal/core-recommended or drupal/cms.');
    const version = lockedCore?.version?.replace(/^v/, '');
    let major = majorFrom(version);
    if (major === undefined && corePackage === 'drupal/cms') { major = 11; report.notes.push('Drupal CMS without a locked core: assuming Drupal 11 (Drupal CMS 1.x is built on core 11). Confirm with the lock file.'); }
    if (major === undefined) major = majorFrom(report.composer.coreConstraint);
    report.drupal = { version: version ?? null, major: major ?? null, source: version ? 'composer.lock' : 'composer.json constraint' };
  } else if (existsSync(join(root, 'includes', 'bootstrap.inc'))) {
    report.drupal = { major: 7, source: 'includes/bootstrap.inc' };
    report.blockers.push('Drupal 7 (non-Composer) codebase: outside the toolkit\'s supported scope.');
  } else if (existsSync(join(root, 'core', 'lib', 'Drupal.php'))) {
    report.blockers.push('Drupal core without composer.json (tarball install): outside the toolkit\'s supported scope.');
  } else {
    report.blockers.push('No composer.json and no Drupal core found at this path.');
  }

  // Layout and web root.
  let webDir = report.composer.webRootSetting?.replace(/^\.\//, '').replace(/\/+$/, '');
  if (webDir === undefined || webDir === null) {
    webDir = ['web', 'docroot', 'html', 'public'].find(d => existsSync(join(root, d, 'index.php')) || existsSync(join(root, d, 'core')));
    if (webDir === undefined && existsSync(join(root, 'index.php'))) webDir = '';
  }
  if (webDir === undefined) {
    report.layout = { type: 'unknown' };
    report.blockers.push('Could not determine the Drupal web root (no drupal-scaffold web-root, no web/, docroot/ or index.php).');
  } else {
    report.layout = {
      type: webDir === '' ? 'repository-root' : `composer-${webDir}`,
      webRootDir: webDir === '' ? '.' : webDir,
      suggestedAppRoot: '/var/www/html',
      suggestedWebRoot: webDir === '' ? '/var/www/html' : `/var/www/html/${webDir}`,
      suggestedStaticFiles: `${webDir === '' ? '/var/www/html' : `/var/www/html/${webDir}`}/sites/default/files`,
      webRootPresentInSource: webDir === '' || existsSync(join(root, webDir)),
    };
    if (!report.layout.webRootPresentInSource) report.notes.push(`Web root ${webDir}/ is created by Composer scaffolding at install time; it is not in the source.`);
  }

  // Suggestions from verified DevPanel data.
  const major = report.drupal.major;
  if (major) {
    const projectType = `drupal${major}_v2`;
    const phpMinimum = SERVER_CONFIG.drupalPhpMinimum[String(major)] ?? null;
    report.suggestions = {
      projectType: SERVER_CONFIG.projectTypeDefaultImage[projectType] ? projectType : null,
      devpanelDefaultImage: SERVER_CONFIG.projectTypeDefaultImage[projectType] ?? null,
      phpMinimum,
      note: 'Suggestions only; the user selects tier, PHP image and MySQL (cluster-level).',
    };
    if (!report.suggestions.projectType) report.blockers.push(`No DevPanel project type known for Drupal ${major}.`);
    if (major < 10) report.notes.push(`Drupal ${major} is end-of-life upstream.`);
  }

  // .devpanel files against the requirement manifest.
  const requirements = REQUIREMENTS_PATH ? readJson(REQUIREMENTS_PATH) : undefined;
  report.devpanel.present = existsSync(join(root, '.devpanel'));
  if (requirements) {
    report.devpanel.items = requirements.items.map(item => ({
      path: item.path, present: existsSync(join(root, item.path.replace(/\/$/, ''))), evidence: item.evidence, required: item.required,
    }));
    report.devpanel.productionTemplatePublished = requirements.productionTemplatePublished;
    report.devpanel.missingEvidence = requirements.missingEvidence;
  } else {
    report.notes.push('templates/drupal/requirements.json not found; .devpanel requirement status unavailable.');
  }

  for (const p of OTHER_DEPLOY) if (existsSync(join(root, p))) report.otherDeploymentConfig.push(p);

  // Risks: reported by path, contents never printed.
  walk(root, 6, (full, entry) => {
    const rel = relative(root, full);
    if (entry.isFile()) {
      if (DUMP_FILE.test(entry.name)) report.risks.push({ path: rel, kind: 'database-dump', tracked: tracked(rel) });
      if (entry.name === '.env') report.risks.push({ path: rel, kind: 'env-file', tracked: tracked(rel) });
      if (/^settings(\.[\w-]+)?\.php$/.test(entry.name) && /sites[\\/][^\\/]+$/.test(dirname(rel))) {
        let text = '';
        try { if (statSync(full).size < 2_000_000) text = readFileSync(full, 'utf8'); } catch { /* unreadable */ }
        if (/['"]password['"]\s*=>\s*['"][^'"]+['"]/.test(text)) report.risks.push({ path: rel, kind: 'hardcoded-database-credentials', tracked: tracked(rel) });
        if (/\$settings\[['"]hash_salt['"]\]\s*=\s*['"][^'"]{8,}['"]/.test(text)) report.risks.push({ path: rel, kind: 'hardcoded-hash-salt', tracked: tracked(rel) });
      }
    } else if (entry.isDirectory()) {
      if (entry.name === 'files' && /sites[\\/][^\\/]+$/.test(dirname(rel)) && tracked(rel)) report.risks.push({ path: rel, kind: 'uploaded-files-in-git', tracked: true });
      if (rel === join('.devpanel', 'dumps')) report.risks.push({ path: rel, kind: 'devpanel-dumps-directory', tracked: tracked(rel) });
    }
  });

  report.supported = report.blockers.length === 0;
  return report;
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
  console.error('Usage: inspect-drupal-source.mjs <path-to-drupal-codebase>');
  process.exit(2);
}
const root = resolve(args.find(a => !a.startsWith('--')) ?? '.');
if (!existsSync(root) || !statSync(root).isDirectory()) {
  console.error(`error: ${root} is not a directory`);
  process.exit(2);
}
console.log(JSON.stringify(inspect(root), null, 2));
