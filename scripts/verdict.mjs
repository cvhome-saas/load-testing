#!/usr/bin/env node
// A run's verdict: what it used of every container of the load stack, judged against k6/config/budgets.js.
//
//   make verdict TESTID=<testid>          node scripts/verdict.mjs <testid>
//   bin/k6run runs it after every run (NO_VERDICT=1 skips it; PROFILE=smoke skips it unless VERDICT=1)
//
// It reads Prometheus over the run's window (the cadvisor series and the load:container_* rules, k6's own counters) and
// prints, per container: its CPU cap, peak CPU against it, how long it stayed at CPU_RATIO or above (longest stretch),
// the share of CPU periods it was throttled, its memory limit and peak memory against it, OOM kills and restarts;
// then the CPU one unit of work cost (landing-ui per page view, uaa per sign-in) in ms of a Fargate vCPU. A soak also
// gets the working set's growth after warm-up. Exit 1 when a budget fails; 0 when every budget holds or there is
// nothing to judge (Prometheus down, or a deployed target, whose containers `make aws-report` reads from CloudWatch).
// The same result goes to results/<testid>.verdict.json for perf-suite.
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {budgets, fmtDuration, fmtTime, pct, promBase, promUp, query, range, root, runWindow, summaryOf, table} from './lib/runs.mjs';

const testid = process.argv[2] || process.env.TESTID;
if (!testid) { console.error('usage: node scripts/verdict.mjs <testid>   (or TESTID=…)'); process.exit(2); }
const profile = process.env.PROFILE || /-(smoke|load|stress|spike|soak|breakpoint)-\d{8}T\d{6}Z$/.exec(testid)?.[1] || '';
const {CONTAINER: C, CPU_PER_UNIT} = await budgets();
const P = 'project="cvhome-load"';
const STEP = 15;
// landing-ui renders a page for every HTTP page view and for every document a browser opens (browser_page_views).
const UNITS = {
  'page view': (range_) => `(sum(max_over_time(k6_http_reqs_total{testid="${testid}",name=~"page:.*"}[${range_}])) or vector(0))` +
    ` + (sum(max_over_time(k6_browser_page_views_total{testid="${testid}"}[${range_}])) or vector(0))`,
  'sign-in': (range_) => `sum(max_over_time(k6_seller_logins_total{testid="${testid}"}[${range_}]))`,
};
const out = {testid, profile, status: 'skipped', failures: [], containers: [], units: []};

function finish(code) {
  mkdirSync(join(root, 'results'), {recursive: true});
  writeFileSync(join(root, 'results', `${testid.replace(/[^A-Za-z0-9_.-]/g, '-')}.verdict.json`), JSON.stringify(out, null, 2) + '\n');
  process.exit(code);
}

if (!(await promUp())) {
  out.reason = `Prometheus is not answering at ${promBase()}`;
  console.log(`verdict  ${testid}: skipped, ${out.reason}`);
  finish(0);
}
const [from, to] = await runWindow(testid);
Object.assign(out, {from, to});
// cAdvisor scrapes every 10 s and the rules evaluate every 15 s: give the run's last seconds time to land.
const wait = to + 20 - Date.now() / 1000;
if (wait > 0) await new Promise((r) => setTimeout(r, wait * 1000));
const end = to + 10;
const d = `${Math.max(60, Math.ceil(end - from))}s`;

const byService = (result) => Object.fromEntries(result.map((r) => [r.metric.service ?? '', r.values ?? r.value]));
const series = async (expr) => byService(await range(expr, from, end, STEP));
const instant = async (expr) => Object.fromEntries((await query(expr, end)).map((r) => [r.metric.service ?? '', Number(r.value[1])]));

// CPU is read from the raw counters, not the load:container_cpu:* rules: the rules look 30 s back so that a live
// dashboard is not missing cAdvisor's last samples, and the verdict runs after the fact, when every sample is in.
const CORES = `sum by (project, service) (rate(container_cpu_usage_seconds_total{${P}}[1m]))`;
const cores = await series(CORES);
if (Object.keys(cores).length === 0) {
  out.reason = 'no load-stack container in this window: a deployed target (make aws-report TESTID=… reads ECS from CloudWatch), or cAdvisor was not running';
  console.log(`verdict  ${testid}: containers skipped, ${out.reason}`);
  finish(0);
}
const [cpuRatio, capCores, throttled, memRatio, memBytes, memLimit, ooms, restarts, shape] = await Promise.all([
  series(`${CORES} / on (project, service) max by (project, service) (load:container_cpu_limit:cores{${P}})`),
  instant(`last_over_time(load:container_cpu_limit:cores{${P}}[${d}])`),
  series(`sum by (project, service) (rate(container_cpu_cfs_throttled_periods_total{${P}}[1m])) / sum by (project, service) (rate(container_cpu_cfs_periods_total{${P}}[1m]))`),
  series(`load:container_memory:ratio{${P}}`),
  instant(`max_over_time(load:container_memory:bytes{${P}}[${d}])`),
  instant(`last_over_time(load:container_memory_limit:bytes{${P}}[${d}])`),
  instant(`max_over_time(load:container_oom_events:total{${P}}[${d}]) - min_over_time(load:container_oom_events:total{${P}}[${d}])`),
  instant(`changes(load:container_start_time:seconds{${P}}[${d}])`),
  query(`group by (flavour, cpu_factor) (last_over_time(container_spec_cpu_period{${P},flavour!=""}[${d}]))`, end),
]);
out.flavour = shape[0]?.metric.flavour ?? 'unknown';
out.cpuFactor = Number(shape[0]?.metric.cpu_factor ?? NaN);

const values = (pairs) => (pairs ?? []).map(([t, v]) => [Number(t), Number(v)]).filter(([, v]) => Number.isFinite(v));
function stretches(pairs, threshold) {
  let total = 0; let longest = 0; let run = 0; let prev = null;
  for (const [t, v] of values(pairs)) {
    const contiguous = prev !== null && t - prev <= STEP * 1.5;
    if (v >= threshold) { run = contiguous && run > 0 ? run + STEP : STEP; total += STEP; } else run = 0;
    longest = Math.max(longest, run);
    prev = t;
  }
  return {total, longest};
}
const peak = (pairs) => Math.max(...values(pairs).map(([, v]) => v), -Infinity);
const mean = (pairs) => { const v = values(pairs); return v.length ? v.reduce((a, [, x]) => a + x, 0) / v.length : NaN; };

let growth = {};
const slopeWindow = Math.ceil(end - from) - C.soakWarmupSeconds;
const judgeGrowth = slopeWindow >= C.memoryGrowthWindowSeconds;
if (profile === 'soak' && slopeWindow >= 300) {
  growth = await instant(`deriv(load:container_memory:bytes{${P}}[${Math.ceil(end - from) - C.soakWarmupSeconds}s]) * 3600 / on (project, service) load:container_memory_limit:bytes{${P}}`);
}

for (const service of Object.keys(cores).sort()) {
  const cap = capCores[service];
  const row = {service, capCores: cap ?? null, peakCores: peak(cores[service])};
  if (cap) {
    const s = stretches(cpuRatio[service], C.cpuRatio);
    Object.assign(row, {peakCpuRatio: peak(cpuRatio[service]), secondsAtCap: s.total, longestAtCap: s.longest, throttled: mean(throttled[service])});
    if (s.longest > C.cpuSustainedSeconds) out.failures.push(`${service}: CPU at ${pct(C.cpuRatio)}+ of its ${cap} cores for ${fmtDuration(s.longest)} in one stretch (budget ${fmtDuration(C.cpuSustainedSeconds)})`);
  }
  row.memLimitBytes = memLimit[service] ?? null;
  row.peakMemBytes = memBytes[service] ?? null;
  if (row.memLimitBytes) {
    row.peakMemRatio = peak(memRatio[service]);
    if (row.peakMemRatio > C.memoryRatio) out.failures.push(`${service}: memory at ${pct(row.peakMemRatio)} of its limit (budget ${pct(C.memoryRatio)})`);
  }
  row.oomKills = Math.round(ooms[service] ?? 0);
  row.restarts = Math.round(restarts[service] ?? 0);
  if (row.oomKills > C.oomKills) out.failures.push(`${service}: ${row.oomKills} OOM kill(s)`);
  if (row.restarts > C.restarts) out.failures.push(`${service}: restarted ${row.restarts} time(s)`);
  if (growth[service] !== undefined) {
    row.memGrowthPerHour = growth[service];
    row.memGrowthJudged = judgeGrowth;
    if (judgeGrowth && row.memGrowthPerHour > C.memoryGrowthPerHour) out.failures.push(`${service}: working set grows ${pct(row.memGrowthPerHour)} of its limit per hour after warm-up (budget ${pct(C.memoryGrowthPerHour)}): a leak`);
  }
  out.containers.push(row);
}

const capped = out.flavour !== 'off' && Number.isFinite(out.cpuFactor);
for (const [service, spec] of Object.entries(CPU_PER_UNIT)) {
  const unitsQuery = UNITS[spec.per];
  if (!unitsQuery) throw new Error(`budgets.js CPU_PER_UNIT.${service}: unknown unit "${spec.per}" (${Object.keys(UNITS).join(', ')})`);
  const [n, cpu] = await Promise.all([
    query(unitsQuery(d), end),
    query(`sum(increase(container_cpu_usage_seconds_total{${P},service="${service}"}[${d}]))`, end),
  ]);
  const units = Number(n[0]?.value[1] ?? 0);
  if (!units) continue;
  const msHere = (Number(cpu[0]?.value[1] ?? NaN) * 1000) / units;
  const row = {service, per: spec.per, units, msHere, msFargate: capped ? msHere / out.cpuFactor : null, budgetMs: spec.budgetMs};
  if (capped && spec.budgetMs !== null && row.msFargate > spec.budgetMs) {
    out.failures.push(`${service}: ${Math.round(row.msFargate)} ms of a Fargate vCPU per ${spec.per} (budget ${spec.budgetMs} ms)`);
  }
  out.units.push(row);
}

out.status = out.failures.length ? 'fail' : 'pass';
const mib = (b) => (b ? `${Math.round(b / 1048576)} MiB` : '-');
const failed = new Set(out.failures.map((f) => f.split(':')[0]));
console.log(`\nverdict  ${testid}  ${fmtTime(from)} → ${fmtTime(to).slice(11)} UTC (${fmtDuration(to - from)})  ` +
  `LOAD_FLAVOUR=${out.flavour}${capped ? `  LOAD_CPU_FACTOR=${out.cpuFactor}` : ''}${profile ? `  PROFILE=${profile}` : ''}`);
const rows = [['container', 'cpu cap', 'peak cpu', `≥${pct(C.cpuRatio)} cap (longest)`, 'throttled', 'mem limit', 'peak mem', 'oom', 'restarts',
  ...(profile === 'soak' ? ['mem growth/h'] : []), '']];
const order = [...out.containers].sort((a, b) => (b.peakCpuRatio ?? -1) - (a.peakCpuRatio ?? -1) || a.service.localeCompare(b.service));
for (const c of order) {
  rows.push([c.service, c.capCores ? `${c.capCores} cores` : 'none', c.capCores ? pct(c.peakCpuRatio) : `${c.peakCores.toFixed(2)} cores`,
    c.capCores ? `${fmtDuration(c.secondsAtCap)} (${fmtDuration(c.longestAtCap)})` : '-', c.capCores ? pct(c.throttled) : '-',
    mib(c.memLimitBytes), c.memLimitBytes ? pct(c.peakMemRatio) : mib(c.peakMemBytes), c.oomKills, c.restarts,
    ...(profile === 'soak' ? [c.memGrowthPerHour === undefined ? '-' : pct(c.memGrowthPerHour)] : []), failed.has(c.service) ? 'FAIL' : '']);
}
console.log(table(rows));
if (profile === 'soak' && slopeWindow >= 300 && !judgeGrowth) {
  console.log(`  memory growth over ${fmtDuration(slopeWindow)} after warm-up: reported, judged from ${fmtDuration(C.memoryGrowthWindowSeconds)} on (SOAK_DURATION)`);
}
if (out.units.length) {
  console.log(capped ? `  CPU per unit of work, in ms of a Fargate vCPU (ms here ÷ ${out.cpuFactor}):` : '  CPU per unit of work, in ms of a core here (LOAD_FLAVOUR=off: no Fargate equivalent, not judged):');
  console.log(table([['container', 'unit', 'units', 'ms here', 'Fargate ms', 'budget', ''], ...out.units.map((u) => [u.service, u.per, u.units,
    u.msHere.toFixed(1), u.msFargate === null ? '-' : u.msFargate.toFixed(1), u.budgetMs ?? 'reported only',
    capped && u.budgetMs !== null ? (u.msFargate > u.budgetMs ? 'FAIL' : 'pass') : ''])]));
}
// The other half of the run's pass/fail, for the reader: what k6's thresholds (latency, errors) said. They already set
// bin/k6run's exit code, so they do not change this script's.
const crossed = Object.entries(summaryOf(testid)?.metrics || {}).flatMap(([metric, m]) => Object.entries(m.thresholds || {})
  .filter(([, t]) => !t.ok).map(([expr]) => {
    const stat = /^(p\(\d+(?:\.\d+)?\)|rate|count|avg|max|min|med)/.exec(expr)?.[1];
    const v = stat ? m.values?.[stat] : undefined;
    const shown = v === undefined ? '' : stat === 'rate' ? ` (${pct(v)})` : stat === 'count' ? ` (${v})` : ` (${v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`})`;
    return `${metric} ${expr}${shown}`;
  }));
out.thresholdsCrossed = crossed;
if (crossed.length) console.log(`  k6 thresholds crossed (latency and errors, thresholds.js): ${crossed.length}\n${crossed.map((c) => `    ${c}`).join('\n')}`);
const containers = out.failures.length ? `FAIL\n${out.failures.map((f) => `  - ${f}`).join('\n')}` : 'pass (k6/config/budgets.js)';
console.log(`verdict: containers ${containers}${crossed.length ? '\n  the run fails on k6\'s thresholds above' : ''}`);
finish(out.failures.length ? 1 : 0);
