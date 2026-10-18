#!/usr/bin/env node
// The package gate: `npm audit` at high, minus the advisories listed below. npm has no way to accept one advisory, and
// an advisory with no patched release fails every push and every CI run until upstream ships one. Each entry names the
// advisory, why it cannot reach this repo, and is removed the moment a fix lands: an entry that no longer matches any
// finding fails the gate too, so a stale allowance cannot hide a later advisory.
//
//   node scripts/audit.mjs      exit 1 on a high or critical advisory not listed here, or on a stale entry
import {execFileSync} from 'node:child_process';

const ALLOWED = {
  // braces <= 3.0.3, stack exhaustion on deeply nested brace patterns; no patched release (2026-10-18). It reaches us
  // only through markdownlint-cli2 → micromatch, which expands the repo's own globs in package.json, never input
  // from outside the repo.
  'GHSA-vfj7-8cjw-p6xm': 'braces: no patched release; dev-only, expands our own markdownlint globs',
};

const LEVELS = new Set(['high', 'critical']);

let raw;
try {
  raw = execFileSync('npm', ['audit', '--json'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit']});
} catch (err) {
  raw = err.stdout; // npm audit exits non-zero whenever it finds anything
}
let report;
try {
  report = JSON.parse(raw);
} catch {
  console.error('npm audit did not return JSON:\n' + raw);
  process.exit(1);
}
if (report.error) {
  console.error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
  process.exit(1);
}

const blocking = [];
const matched = new Set();
for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of vuln.via) {
    if (typeof via === 'string' || !LEVELS.has(via.severity)) continue; // a string is a package, reported on its own
    const id = via.url?.split('/').pop();
    if (id in ALLOWED) matched.add(id);
    else blocking.push(`${via.severity} ${name} ${via.range}: ${via.title} (${via.url})`);
  }
}
const stale = Object.keys(ALLOWED).filter((id) => !matched.has(id));

for (const id of matched) console.log(`audit: allowed ${id} (${ALLOWED[id]})`);
for (const id of stale) console.error(`audit: ${id} no longer reported; remove it from scripts/audit.mjs`);
for (const line of [...new Set(blocking)]) console.error(`audit: ${line}`);
if (blocking.length || stale.length) process.exit(1);
console.log('audit: no high or critical advisory outside the allow-list');
