#!/usr/bin/env node
// Structured execution record for one workflow run. Stored outside any
// repository, under ${XDG_STATE_HOME:-~/.local/state}/dp-ai-toolkit/runs/. Refuses keys
// and values that look like credentials or signed URLs, without echoing the value.
// Exit codes: 0 ok, 2 usage error, 4 refused (secret-like input).
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const USAGE = `Usage:
  exec-record.mjs init --workflow <name>          prints the record path
  exec-record.mjs set <record> key.path=value ...  scalar fields (target.*, resources.*, verification.*, status)
  exec-record.mjs add <record> <list> <value>      list: planIds|activityIds|completedSteps|pending|errors|notes
  exec-record.mjs show <record>
  exec-record.mjs list`;

const LISTS = new Set(['planIds', 'activityIds', 'completedSteps', 'pending', 'errors', 'notes']);
const SETTABLE_ROOTS = new Set(['target', 'resources', 'verification', 'status']);
const WORKFLOWS = new Set(['create-project-from-template', 'create-project-from-repository', 'create-branch-environment', 'sync-environment-data', 'deploy-existing-site', 'diagnostics']);

// Key names that never belong in a record. planHash is a plan fingerprint, not a secret.
const SECRET_KEY = /(pass(word)?|pwd|secret|token|credential|private.?key|api.?key|authorization|bearer|cookie)/i;
const ALLOWED_KEYS = new Set(['planHash']);
const SECRET_VALUE = [
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,       // GitHub classic/OAuth/app tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,                 // GitHub fine-grained tokens
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,    // JWTs (Cognito/DevPanel access tokens)
  /\bBearer\s+\S{8,}/i,
  /[?&](X-Amz-Signature|X-Amz-Credential|Signature|sig|se|sv|token|access_token)=/i, // signed URLs
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /:\/\/[^\s/:@]+:[^\s/@]+@/,                       // credentials embedded in URLs
];

class UsageError extends Error {}
class RefusedError extends Error {}

const runsDir = () => join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'dp-ai-toolkit', 'runs');

function toolkitVersion() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, '..', 'VERSION'), join(here, '..', '..', '..', 'VERSION')]) {
    if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  }
  return 'unknown';
}

function checkSafe(key, value) {
  const segments = key.split('.');
  if (segments.some(s => SECRET_KEY.test(s) && !ALLOWED_KEYS.has(s))) {
    throw new RefusedError(`Refused: key "${key}" names a credential. Records never hold secrets.`);
  }
  if (typeof value === 'string' && SECRET_VALUE.some(re => re.test(value))) {
    throw new RefusedError(`Refused: the value for "${key}" looks like a credential or signed URL. It was not written.`);
  }
}

function load(path) {
  const full = resolve(path);
  if (!existsSync(full)) throw new UsageError(`No record at ${full}`);
  return { full, record: JSON.parse(readFileSync(full, 'utf8')) };
}

function save(full, record) {
  record.updatedAt = new Date().toISOString();
  const tmp = `${full}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, full);
}

function parseScalar(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  return raw;
}

function init(argv) {
  const i = argv.indexOf('--workflow');
  const workflow = i >= 0 ? argv[i + 1] : undefined;
  if (!workflow || !WORKFLOWS.has(workflow)) throw new UsageError(`--workflow must be one of: ${[...WORKFLOWS].join(', ')}`);
  const dir = runsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const full = join(dir, `${stamp}-${workflow}-${randomBytes(3).toString('hex')}.json`);
  const record = {
    schemaVersion: 1, toolkitVersion: toolkitVersion(), workflow, status: 'in_progress',
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
    target: {}, resources: {}, planIds: [], activityIds: [], completedSteps: [], pending: [], errors: [], notes: [], verification: {},
  };
  writeFileSync(full, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(full);
}

function set(argv) {
  const [path, ...pairs] = argv;
  if (!path || pairs.length === 0) throw new UsageError('set needs a record path and at least one key=value');
  const { full, record } = load(path);
  const updates = pairs.map(pair => {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new UsageError(`Expected key=value, got "${pair}"`);
    const key = pair.slice(0, eq);
    const value = parseScalar(pair.slice(eq + 1));
    const segments = key.split('.');
    if (!SETTABLE_ROOTS.has(segments[0])) throw new UsageError(`Key must start with one of: ${[...SETTABLE_ROOTS].join(', ')}`);
    if (segments.some(s => !/^[A-Za-z0-9_-]+$/.test(s))) throw new UsageError(`Invalid key "${key}"`);
    checkSafe(key, value);
    return { segments, value };
  });
  // Validate everything before writing anything.
  for (const { segments, value } of updates) {
    if (segments.length === 1) { record[segments[0]] = value; continue; }
    let node = record;
    for (const s of segments.slice(0, -1)) {
      if (typeof node[s] !== 'object' || node[s] === null || Array.isArray(node[s])) node[s] = {};
      node = node[s];
    }
    node[segments.at(-1)] = value;
  }
  save(full, record);
}

function add(argv) {
  const [path, list, ...rest] = argv;
  const value = rest.join(' ');
  if (!path || !list || !value) throw new UsageError('add needs a record path, a list name and a value');
  if (!LISTS.has(list)) throw new UsageError(`List must be one of: ${[...LISTS].join(', ')}`);
  checkSafe(list, value);
  const { full, record } = load(path);
  record[list] ??= [];
  if (!record[list].includes(value)) record[list].push(value);
  save(full, record);
}

function list() {
  const dir = runsDir();
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter(n => n.endsWith('.json')).sort()) console.log(join(dir, basename(f)));
}

try {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'init') init(rest);
  else if (cmd === 'set') set(rest);
  else if (cmd === 'add') add(rest);
  else if (cmd === 'show') { if (!rest[0]) throw new UsageError('show needs a record path'); console.log(JSON.stringify(load(rest[0]).record, null, 2)); }
  else if (cmd === 'list') list();
  else throw new UsageError(cmd ? `Unknown command "${cmd}"` : 'Missing command');
} catch (error) {
  if (error instanceof RefusedError) { console.error(error.message); process.exitCode = 4; }
  else if (error instanceof UsageError) { console.error(`error: ${error.message}\n\n${USAGE}`); process.exitCode = 2; }
  else throw error;
}
