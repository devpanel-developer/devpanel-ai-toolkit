#!/usr/bin/env node
// Lists supported DevPanel server configuration options and maps a user's selection
// (CPU/memory tier, PHP, MySQL, roots, storage) to devpanel_plan_activate_application
// arguments. Data: ../assets/server-config.json. Exit codes: 0 ok, 2 invalid input,
// 3 selection needs resolution with the user before activation.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'server-config.json'), 'utf8'));

const USAGE = `Usage:
  server-config.mjs options [--project-type <type>] [--json]
  server-config.mjs map --capacity <tier> (--php <version> [--variant base|secure|advance|apache] | --image <image>)
                        --mysql <cluster-default|version> [--mysql-confirmed]
                        --app-root <path> --web-root <path> [--storage <GiB>] [--capacity-limit <tier>]
                        [--project-type <type>] [--drupal-major <n>] [--allow-unlisted-tier]`;

class UsageError extends Error {}

function parseArgs(argv) {
  const flags = new Set(['json', 'mysql-confirmed', 'allow-unlisted-tier']);
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (flags.has(key)) { out[key] = true; continue; }
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`Missing value for --${key}`);
    out[key] = value;
  }
  return out;
}

const tierIndex = name => DATA.capacityTiers.findIndex(t => t.name === name);
const phpVersionOf = image => /^devpanel\/php:(\d+\.\d+)-/.exec(image)?.[1];
const versionLess = (a, b) => {
  const [a1, a2] = a.split('.').map(Number); const [b1, b2] = b.split('.').map(Number);
  return a1 < b1 || (a1 === b1 && a2 < b2);
};

function options(args) {
  const projectType = args['project-type'];
  const result = {
    capacityTiers: DATA.capacityTiers.map(({ name, cpu, memory, listedByDevPanel, note }) => ({ name, cpu, memory, listedByDevPanel, ...(note ? { note } : {}) })),
    unlistedTierNote: DATA.unlistedTierNote,
    php: Object.fromEntries(Object.entries(DATA.phpImages.versions)),
    ...(projectType ? { projectTypeDefaultImage: DATA.projectTypeDefaultImage[projectType] ?? null } : {}),
    mysql: { perApplication: false, explanation: DATA.mysql.explanation, knownEngineVersions: DATA.mysql.knownEngineVersions, resolution: DATA.mysql.resolution },
    storage: { defaultGiB: DATA.activationDefaults.storage, note: 'Storage can only grow after activation.' },
  };
  if (args.json) return JSON.stringify(result, null, 2);
  const lines = ['CPU/memory tiers (CPU and memory are coupled):'];
  for (const t of result.capacityTiers) lines.push(`  ${t.name.padEnd(12)} ${`${t.cpu} CPU`.padEnd(10)} ${t.memory.padEnd(6)}${t.listedByDevPanel ? '' : '  (not in DevPanel capacity listing; confirm plan allows it)'}${t.note ? `  ${t.note}` : ''}`);
  lines.push('', 'PHP container images:');
  for (const [v, images] of Object.entries(result.php)) lines.push(`  PHP ${v}: ${images.join(', ')}`);
  if (projectType) lines.push('', `DevPanel default image for ${projectType}: ${result.projectTypeDefaultImage ?? 'unknown'}`);
  lines.push('', `MySQL: ${DATA.mysql.explanation}`, `  Known cluster versions: ${DATA.mysql.knownEngineVersions.join(', ')}`, `  ${DATA.mysql.resolution}`);
  lines.push('', `Storage: default ${result.storage.defaultGiB} GiB; ${result.storage.note}`);
  return lines.join('\n');
}

function map(args) {
  const issues = [];
  const notes = [];

  const capacity = args.capacity;
  if (!capacity) throw new UsageError('--capacity is required');
  const tier = DATA.capacityTiers[tierIndex(capacity)];
  if (!tier) throw new UsageError(`Unknown capacity tier "${capacity}". Valid: ${DATA.capacityTiers.map(t => t.name).join(', ')}`);
  if (!tier.listedByDevPanel && !args['allow-unlisted-tier']) {
    issues.push(`Tier ${capacity} is not offered by DevPanel's capacity listing. Confirm the workspace plan allows it, then pass --allow-unlisted-tier.`);
  }

  let capacityLimit = args['capacity-limit'] ?? capacity;
  if (tierIndex(capacityLimit) < 0) throw new UsageError(`Unknown capacity limit tier "${capacityLimit}"`);
  if (capacity === 'over_commit') {
    capacityLimit = 'large_1';
    notes.push('capacity over_commit: DevPanel forces capacityLimit=large_1.');
  } else if (tierIndex(capacityLimit) < tierIndex(capacity)) {
    issues.push(`capacityLimit ${capacityLimit} is below capacity ${capacity}; the limit must be at least the requested tier.`);
  }

  if (Boolean(args.php) === Boolean(args.image)) throw new UsageError('Pass exactly one of --php or --image');
  let containerImage;
  let phpVersion;
  if (args.php) {
    phpVersion = args.php;
    const images = DATA.phpImages.versions[phpVersion];
    if (!images) throw new UsageError(`Unsupported PHP version "${phpVersion}". Supported: ${Object.keys(DATA.phpImages.versions).join(', ')}`);
    containerImage = `devpanel/php:${phpVersion}-${args.variant ?? 'base'}`;
    if (!images.includes(containerImage)) throw new UsageError(`No image ${containerImage}. Available for PHP ${phpVersion}: ${images.join(', ')}`);
  } else {
    containerImage = args.image.trim();
    if (!containerImage || /\s/.test(containerImage)) throw new UsageError('--image must be a single image reference');
    if (containerImage === DATA.activationDefaults.containerImage) issues.push(`${containerImage} is the MCP's generic fallback image; choose a stack-specific image.`);
    phpVersion = phpVersionOf(containerImage);
    if (!phpVersion) notes.push(`PHP version is determined by image ${containerImage}; it cannot be verified here.`);
  }

  const drupalMajor = args['drupal-major'];
  if (drupalMajor) {
    const min = DATA.drupalPhpMinimum[drupalMajor];
    if (!min) notes.push(`No PHP minimum recorded for Drupal ${drupalMajor}.`);
    else if (phpVersion && versionLess(phpVersion, min)) issues.push(`Drupal ${drupalMajor} requires PHP >= ${min}; selected PHP ${phpVersion}.`);
  }

  const projectType = args['project-type'];
  if (projectType) {
    const def = DATA.projectTypeDefaultImage[projectType];
    if (def && def !== containerImage) notes.push(`DevPanel's default image for ${projectType} is ${def}; the selection overrides it.`);
  }

  const mysql = args.mysql;
  if (!mysql) throw new UsageError('--mysql is required (cluster-default or a version the user asked for)');
  let mysqlRecord;
  if (mysql === 'cluster-default') {
    mysqlRecord = { requested: null, source: 'workspace cluster', confirmed: true };
    notes.push('MySQL: the workspace cluster\'s engine version applies; it is not an MCP argument.');
  } else {
    const known = DATA.mysql.knownEngineVersions.some(v => v === mysql || v.startsWith(`${mysql}.`) || mysql.startsWith(`${v}.`));
    if (!known) notes.push(`MySQL ${mysql} is not among the engine versions DevPanel environments define (${DATA.mysql.knownEngineVersions.join(', ')}).`);
    if (args['mysql-confirmed']) {
      mysqlRecord = { requested: mysql, source: 'workspace cluster (user-confirmed)', confirmed: true };
      notes.push(`MySQL ${mysql}: user confirmed the workspace cluster provides it; not passed to MCP.`);
    } else {
      mysqlRecord = { requested: mysql, source: 'workspace cluster', confirmed: false };
      issues.push(`MySQL ${mysql} cannot be selected per application. ${DATA.mysql.resolution} Re-run with --mysql-confirmed after confirmation.`);
    }
  }

  const appRoot = args['app-root'];
  const webRoot = args['web-root'];
  if (!appRoot || !webRoot) throw new UsageError('--app-root and --web-root are required (stack-specific; MCP defaults are not stack-aware)');
  for (const [k, v] of [['app-root', appRoot], ['web-root', webRoot]]) {
    if (!v.startsWith('/') || v.split('/').includes('..')) throw new UsageError(`--${k} must be an absolute path without ".." segments`);
  }
  if (webRoot !== appRoot && !webRoot.startsWith(`${appRoot.replace(/\/+$/, '')}/`)) issues.push(`webRoot ${webRoot} is not inside appRoot ${appRoot}.`);

  let storage = DATA.activationDefaults.storage;
  if (args.storage !== undefined) {
    storage = Number(args.storage);
    if (!Number.isInteger(storage) || storage < 1) throw new UsageError('--storage must be a positive integer (GiB)');
  } else {
    notes.push(`storage: using ${storage} GiB (MCP default); confirm with the user.`);
  }

  return {
    status: issues.length > 0 ? 'needs_resolution' : 'ok',
    selection: { tier: tier.name, cpu: tier.cpu, memory: tier.memory, php: phpVersion ?? 'image-defined', mysql: mysqlRecord },
    activationArgs: {
      capacity, capacityLimit, containerImage, appRoot, webRoot, storage,
      copyDatabaseFilesType: '', isFromGit: true,
    },
    issues,
    notes,
  };
}

try {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === 'options') {
    console.log(options(args));
  } else if (cmd === 'map') {
    const result = map(args);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === 'ok' ? 0 : 3;
  } else {
    throw new UsageError(cmd ? `Unknown command "${cmd}"` : 'Missing command');
  }
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  console.error(`error: ${error.message}\n\n${USAGE}`);
  process.exitCode = 2;
}
