#!/usr/bin/env node
// Copies the Fargate task sizes out of cvhome-platform into stack/fargate-sizes.json, so the load stack can run every
// service at the CPU and memory its task gets on AWS (stack/stack.sh, LOAD_FLAVOUR). The platform owns the numbers:
// flavours.yaml says what each size is in each environment, services.yaml which size each service takes, and the
// flavour's rds block which instance class the database is.
//
//   node scripts/sync-fargate-sizes.mjs           rewrite stack/fargate-sizes.json from the platform checkout
//   node scripts/sync-fargate-sizes.mjs --check   fail when the copy is stale; skip (exit 0) without a checkout
//
// The checkout is CVHOME_PLATFORM when set, else the first cvhome-platform/ beside this repo or beside one of its
// parents, so a worktree under .claude/worktrees/ finds the one next to the primary checkout. The two YAML files are
// read with a line parser that knows only the shapes it needs; anything it cannot read fails loudly.
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(root, 'stack', 'fargate-sizes.json');
const check = process.argv.includes('--check');

// The database is RDS, not a task: its instance class decides CPU and memory. vCPU x 1024 and MiB, from the AWS
// instance type table. Burstable classes run unlimited on RDS, so a load test sees every vCPU.
const RDS_CLASSES = {
  'db.t4g.micro': {cpu: 2048, memory: 1024},
  'db.t4g.small': {cpu: 2048, memory: 2048},
  'db.t4g.medium': {cpu: 2048, memory: 4096},
  'db.t4g.large': {cpu: 2048, memory: 8192},
};

function platformDir() {
  if (process.env.CVHOME_PLATFORM) {
    const dir = resolve(process.env.CVHOME_PLATFORM);
    return existsSync(join(dir, 'flavours.yaml')) ? dir : null;
  }
  for (let dir = root; ; dir = dirname(dir)) {
    const candidate = join(dir, '..', 'cvhome-platform');
    if (existsSync(join(candidate, 'flavours.yaml'))) return resolve(candidate);
    if (dirname(dir) === dir) return null;
  }
}

/** Lines of a YAML file as {indent, key, value, line}, comments and blank lines dropped. */
function lines(file) {
  return readFileSync(file, 'utf8').split('\n').map((text, i) => {
    const bare = text.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, '');
    const m = /^( *)([A-Za-z0-9_.-]+):\s*(.*)$/.exec(bare);
    return m ? {indent: m[1].length, key: m[2], value: m[3].trim(), line: i + 1} : null;
  }).filter(Boolean);
}

/** `{ cpu: 512, memory: 1024 }` → {cpu: 512, memory: 1024}. */
function flowMap(value, where) {
  const m = /^\{(.*)\}$/.exec(value);
  if (!m) throw new Error(`${where}: expected { cpu: N, memory: N }, got "${value}"`);
  return Object.fromEntries(m[1].split(',').map((pair) => {
    const [k, v] = pair.split(':').map((s) => s.trim());
    return [k, Number(v)];
  }));
}

function readFlavours(file) {
  const flavours = {};
  let flavour = null;
  let block = null;
  for (const l of lines(file)) {
    if (l.indent === 0) { flavour = {sizes: {}, rds: {}}; flavours[l.key] = flavour; block = null; continue; }
    if (!flavour) continue;
    if (l.indent === 2) {
      block = l.value === '' ? l.key : null;
      if (l.key === 'desired_count') flavour.desiredCount = Number(l.value);
      continue;
    }
    if (l.indent === 4 && block === 'sizes') flavour.sizes[l.key] = flowMap(l.value, `flavours.yaml:${l.line}`);
    if (l.indent === 4 && block === 'rds' && l.key === 'instance_class') flavour.rds.instanceClass = l.value;
    if (l.indent === 4 && block === 'rds' && l.key === 'db_pool_size') flavour.rds.dbPoolSize = Number(l.value);
  }
  return flavours;
}

function readServices(file) {
  const services = {};
  let service = null;
  for (const l of lines(file)) {
    if (l.indent === 0) { service = null; continue; }
    if (l.indent === 2 && l.value === '') { service = {name: l.key}; services[l.key] = service; continue; }
    if (service && l.indent === 4 && (l.key === 'size' || l.key === 'runtime')) service[l.key] = l.value;
    // A service may take a pool of its own (catalog 8) over the flavour's rds.db_pool_size.
    if (service && l.indent === 4 && l.key === 'db_pool_size') service.dbPoolSize = Number(l.value);
  }
  return Object.values(services).filter((s) => s.size);
}

function build(dir) {
  const flavours = readFlavours(join(dir, 'flavours.yaml'));
  const services = readServices(join(dir, 'services.yaml'));
  if (Object.keys(flavours).length === 0) throw new Error('flavours.yaml: no flavour found');
  if (services.length === 0) throw new Error('services.yaml: no service with a size found');
  const out = {
    _generated: 'by scripts/sync-fargate-sizes.mjs from cvhome-platform flavours.yaml + services.yaml; do not edit',
    _units: 'cpu in Fargate CPU units (1024 = 1 vCPU), memory in MiB; postgres is the flavour\'s RDS instance class; '
    + 'dbPoolSize is the flavour\'s Hikari pool, and a service\'s own where services.yaml gives it one',
    flavours: {},
  };
  for (const [name, f] of Object.entries(flavours)) {
    const rds = RDS_CLASSES[f.rds.instanceClass];
    if (!rds) throw new Error(`flavours.yaml ${name}: RDS class ${f.rds.instanceClass} is not in RDS_CLASSES; add it`);
    const entry = {desiredCount: f.desiredCount, dbPoolSize: f.rds.dbPoolSize, services: {}};
    for (const s of [...services].sort((a, b) => a.name.localeCompare(b.name))) {
      const size = f.sizes[s.size];
      if (!size) throw new Error(`flavours.yaml ${name}: no size "${s.size}" (services.yaml ${s.name})`);
      entry.services[s.name] = {size: s.size, cpu: size.cpu, memory: size.memory};
      if (s.dbPoolSize) entry.services[s.name].dbPoolSize = s.dbPoolSize;
    }
    entry.services.postgres = {size: f.rds.instanceClass, cpu: rds.cpu, memory: rds.memory};
    out.flavours[name] = entry;
  }
  return JSON.stringify(out, null, 2) + '\n';
}

const dir = platformDir();
if (!dir) {
  const msg = process.env.CVHOME_PLATFORM ? `no flavours.yaml in CVHOME_PLATFORM=${process.env.CVHOME_PLATFORM}`
    : 'no cvhome-platform checkout beside this repo (set CVHOME_PLATFORM)';
  if (check) { console.log(`fargate sizes: skipped, ${msg}`); process.exit(0); }
  console.error(msg); process.exit(1);
}
const next = build(dir);
if (check) {
  const current = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
  if (current !== next) {
    console.error(`stack/fargate-sizes.json is stale against ${dir}: run node scripts/sync-fargate-sizes.mjs`);
    process.exit(1);
  }
  console.log(`fargate sizes: stack/fargate-sizes.json matches ${dir}`);
} else {
  writeFileSync(outFile, next);
  console.log(`wrote stack/fargate-sizes.json from ${dir}`);
}
