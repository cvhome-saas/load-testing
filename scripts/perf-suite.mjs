#!/usr/bin/env node
// The whole picture in one command: on the capped load stack, smoke → load → spike with recovery → the spike in a
// browser → page breakpoint → sign-in burst → a short soak, then the page budget, and one table at the end: each check, its number, its budget,
// pass or fail. Against a deployed target (TARGET=aws) the same sequence without the stack step, with aws-report
// after every run.
//
//   make perf-suite                       TARGET=aws make perf-suite
//   SUITE_STEPS=load,page-budget make perf-suite       run some steps only
//
// Knobs (environment; every k6 knob in `make knobs` passes through):
//   SUITE_STEPS=stack,smoke,load,spike,browser-spike,page-breakpoint,sign-in-burst,soak,page-budget
//   SUITE_LOAD_VUS=30 (dev's shopper count of 2026-09-13)  SUITE_SPIKE_VUS=10 (×10 at the spike's top)
//   SUITE_LOAD_DURATION=5m  SUITE_SOAK=10m  SUITE_SIGNIN_DURATION=3m  PAGE_MAX_RPS=20  RAMP=10m
// Each run is an ordinary bin/k6run run (its testid, Grafana region, verdict); the table reads results/<testid>.json
// (k6's thresholds), results/<testid>.verdict.json and results/page-budget-*.json. Exit 1 when any check failed.
import {spawnSync} from 'node:child_process';
import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {budgets, fmtDuration, pct, root, summaryOf, table, targetFile} from './lib/runs.mjs';

const target = process.env.TARGET || 'local';
const file = targetFile(target);
const local = target === 'local';
const ALL = ['stack', 'smoke', 'load', 'spike', 'browser-spike', 'page-breakpoint', 'sign-in-burst', 'soak', 'page-budget'];
const steps = (process.env.SUITE_STEPS || ALL.join(',')).split(',').map((s) => s.trim()).filter((s) => ALL.includes(s) && (local || s !== 'stack'));
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
const stores = process.env.STORES || (file.stores.some((s) => s.name === 'org1-store2') ? 'org1-store2' : file.stores[0].name);
const ramp = process.env.RAMP || '10m';
const maxRps = Number(process.env.PAGE_MAX_RPS || 20);
const {CONTAINER: C, CPU_PER_UNIT} = await budgets();
const rows = [];
const check = (step, name, number, budget, result) => rows.push([step, name, number, budget, result]);
let awsNoCredentials = false;

function run(cmd, args, env = {}) {
  console.log(`\n==> perf-suite  ${[cmd, ...args].join(' ')}  ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  return spawnSync(cmd, args, {cwd: root, stdio: 'inherit', env: {...process.env, TARGET: target, STORES: stores, ...env}}).status;
}

function k6(step, script, profile, env = {}) {
  const testid = `${step}-${profile}-${stamp()}`;
  const status = run('bin/k6run', [`k6/scripts/${script}.js`], {PROFILE: profile, TESTID: testid, ...env});
  const summary = summaryOf(testid);
  const thresholds = Object.entries(summary?.metrics || {}).flatMap(([metric, m]) =>
    Object.entries(m.thresholds || {}).map(([expr, t]) => ({metric, expr, ok: t.ok, values: m.values})));
  const held = thresholds.filter((t) => t.ok).length;
  check(step, 'k6 thresholds', summary ? `${held}/${thresholds.length} held` : `no summary (k6 exit ${status})`, 'all', summary && held === thresholds.length ? 'pass' : 'FAIL');
  for (const t of thresholds.filter((x) => !x.ok)) {
    const stat = /^(p\(\d+(?:\.\d+)?\)|rate|count|avg|max|min|med)/.exec(t.expr)?.[1];
    const v = stat ? t.values?.[stat] : undefined;
    check(step, `  ${t.metric}`, v === undefined ? '-' : (stat === 'rate' ? pct(v) : Math.round(v)), t.expr, 'FAIL');
  }
  const verdictFile = join(root, 'results', `${testid}.verdict.json`);
  const verdict = existsSync(verdictFile) ? JSON.parse(readFileSync(verdictFile, 'utf8')) : null;
  if (verdict?.status === 'pass' || verdict?.status === 'fail') {
    const capped = verdict.containers.filter((c) => c.capCores);
    const busiest = [...capped].sort((a, b) => b.longestAtCap - a.longestAtCap || b.peakCpuRatio - a.peakCpuRatio)[0];
    if (busiest) {
      check(step, 'container CPU at its cap', `${busiest.service} ${pct(busiest.peakCpuRatio)}, ≥${pct(C.cpuRatio)} for ${fmtDuration(busiest.longestAtCap)}`,
        `≤ ${fmtDuration(C.cpuSustainedSeconds)} at ≥${pct(C.cpuRatio)}`, busiest.longestAtCap > C.cpuSustainedSeconds ? 'FAIL' : 'pass');
    }
    const mem = [...verdict.containers].filter((c) => c.memLimitBytes).sort((a, b) => b.peakMemRatio - a.peakMemRatio)[0];
    if (mem) check(step, 'container memory', `${mem.service} ${pct(mem.peakMemRatio)}`, `≤ ${pct(C.memoryRatio)}`, mem.peakMemRatio > C.memoryRatio ? 'FAIL' : 'pass');
    const ooms = verdict.containers.reduce((n, c) => n + c.oomKills, 0);
    const restarts = verdict.containers.reduce((n, c) => n + c.restarts, 0);
    check(step, 'OOM kills / restarts', `${ooms} / ${restarts}`, `${C.oomKills} / ${C.restarts}`, ooms > C.oomKills || restarts > C.restarts ? 'FAIL' : 'pass');
    for (const u of verdict.units) {
      const budget = CPU_PER_UNIT[u.service]?.budgetMs;
      check(step, `${u.service} CPU per ${u.per}`, u.msFargate === null ? `${u.msHere.toFixed(0)} ms here` : `${u.msFargate.toFixed(0)} ms Fargate (${u.msHere.toFixed(0)} here)`,
        budget ? `${budget} ms` : 'reported', budget && u.msFargate !== null ? (u.msFargate > budget ? 'FAIL' : 'pass') : 'info');
    }
    const growth = verdict.containers.filter((c) => c.memGrowthPerHour !== undefined).sort((a, b) => b.memGrowthPerHour - a.memGrowthPerHour)[0];
    if (growth) {
      check(step, 'memory growth after warm-up', `${growth.service} ${pct(growth.memGrowthPerHour)}/h`, `≤ ${pct(C.memoryGrowthPerHour)}/h` + (growth.memGrowthJudged ? '' : ' (judged on a 30-min soak)'),
        !growth.memGrowthJudged ? 'info' : growth.memGrowthPerHour > C.memoryGrowthPerHour ? 'FAIL' : 'pass');
    }
  } else if (local && profile !== 'smoke') {
    check(step, 'verdict', verdict?.reason || 'none', 'budgets.js', 'FAIL');
  }
  if (!local && !awsNoCredentials) {
    const s = run('node', ['scripts/aws-report.mjs', testid]);
    if (s === 2) awsNoCredentials = true;
    check(step, 'aws-report', s === 0 ? `results/${testid}.aws-report.json` : 'no AWS credentials', '-', 'info');
  }
  return {testid, summary};
}

for (const step of steps) {
  if (step === 'stack') {
    const s = run('stack/stack.sh', ['up']);
    check('stack', 'make stack-up at AWS sizes', s === 0 ? `LOAD_FLAVOUR=${process.env.LOAD_FLAVOUR || 'dev'}` : `exit ${s}`, 'every service UP', s === 0 ? 'pass' : 'FAIL');
    if (s !== 0) break;
  }
  if (step === 'smoke') k6('smoke', 'smoke', 'smoke');
  if (step === 'load') {
    const {summary} = k6('load', 'storefront/browse', 'load', {PEAK_VUS: process.env.SUITE_LOAD_VUS || '30', DURATION: process.env.SUITE_LOAD_DURATION || '5m'});
    const pages = Object.entries(summary?.metrics || {}).filter(([k]) => /^http_req_duration\{name:page:/.test(k)).map(([k, m]) => [k.slice(23, -1), m.values?.['p(95)']]);
    const worst = pages.sort((a, b) => b[1] - a[1])[0];
    if (worst) check('load', 'worst page p95', `${worst[0]} ${(worst[1] / 1000).toFixed(2)} s`, '3 s (thresholds.js)', worst[1] < 3000 ? 'pass' : 'FAIL');
  }
  if (step === 'spike') {
    const {summary} = k6('spike', 'storefront/browse', 'spike', {PEAK_VUS: process.env.SUITE_SPIKE_VUS || '10'});
    const rec = summary?.metrics?.['http_req_duration{scenario:recovery}'];
    if (rec) check('spike', 'recovery probe p95 after the spike', `${(rec.values['p(95)'] / 1000).toFixed(2)} s`, '3 s', Object.values(rec.thresholds || {}).every((t) => t.ok) ? 'pass' : 'FAIL');
  }
  if (step === 'browser-spike') {
    // The same spike, with Chromium shoppers measured before it, in it and after it; one row per window, its budget
    // read from the threshold lines thresholds.js gave the run.
    const {summary} = k6('browser-spike', 'browser/storefront-spike', 'spike', {PEAK_VUS: process.env.SUITE_SPIKE_VUS || '10'});
    const sec = (v) => (v === undefined ? '-' : `${(v / 1000).toFixed(2)} s`);
    for (const phase of ['ui-base', 'ui-peak', 'ui-recovery']) {
      const lines = [[`browser_web_vital_lcp{scenario:${phase}}`, 'p(75)', sec], [`browser_web_vital_ttfb{scenario:${phase}}`, 'p(75)', sec],
        [`browser_http_req_duration{scenario:${phase},resource_type:Fetch}`, 'p(95)', sec], [`journey_errors{scenario:${phase}}`, 'rate', pct]];
      // a window where no visit finished has no sample: k6 prints its trends as 0 and passes them; its failed visits say why
      const got = lines.map(([k, stat, f]) => {
        const values = summary?.metrics?.[k]?.values;
        return values?.[stat] === undefined || (stat !== 'rate' && !values.max) ? '-' : f(values[stat]);
      });
      const budget = lines.map(([k]) => Object.keys(summary?.metrics?.[k]?.thresholds || {})[0] || '-');
      const ok = lines.every(([k]) => Object.values(summary?.metrics?.[k]?.thresholds || {}).every((t) => t.ok));
      check('browser-spike', `${phase}: LCP p75, TTFB p75, API p95, failed visits`, got.join(', '), budget.join(', '), summary && ok ? 'pass' : 'FAIL');
    }
  }
  if (step === 'page-breakpoint') {
    const {summary} = k6('page-breakpoint', 'storefront/page-breakpoint', 'breakpoint', {PAGE_MAX_RPS: String(maxRps), RAMP: ramp});
    const seconds = (summary?.state?.testRunDurationMs ?? 0) / 1000;
    const rampSeconds = /^(\d+)m$/.test(ramp) ? Number(ramp.slice(0, -1)) * 60 : Number(ramp.replace(/s$/, ''));
    const aborted = Object.values(summary?.metrics || {}).some((m) => Object.values(m.thresholds || {}).some((t) => !t.ok));
    // The ramp offers 1 → PAGE_MAX_RPS over RAMP; the thresholds abort 30 s after the breach (delayAbortEval).
    const knee = 1 + (maxRps - 1) * Math.min(1, Math.max(0, seconds - 30) / rampSeconds);
    check('page-breakpoint', 'landing-ui knee', aborted ? `≈ ${knee.toFixed(1)} page views/s (aborted after ${fmtDuration(seconds)})` : `none up to ${maxRps}/s`, `found below ${maxRps}/s`, 'info');
  }
  if (step === 'sign-in-burst') {
    const {summary} = k6('sign-in-burst', 'platform/sign-in-burst', 'load', {DURATION: process.env.SUITE_SIGNIN_DURATION || '3m'});
    for (const hop of ['submit', 'authorize', 'callback']) {
      const m = summary?.metrics?.[`http_req_duration{name:seller:login-${hop}}`];
      if (m) check('sign-in-burst', `seller:login-${hop} p95`, `${Math.round(m.values['p(95)'])} ms`, '-', 'info');
    }
  }
  if (step === 'soak') k6('soak', 'storefront/soak', 'soak', {PEAK_VUS: process.env.SUITE_LOAD_VUS || '20', SOAK_DURATION: process.env.SUITE_SOAK || '10m'});
  if (step === 'page-budget') {
    const before = Date.now();
    const s = run('node', ['scripts/page-budget.mjs']);
    const out = readdirSync(join(root, 'results')).filter((n) => n.startsWith(`page-budget-${target}-`)).map((n) => join(root, 'results', n))
      .filter((p) => statSync(p).mtimeMs >= before).sort().pop();
    const result = out ? JSON.parse(readFileSync(out, 'utf8')) : null;
    const over = result ? result.rows.filter((r) => r.failures.length).length : null;
    check('page-budget', 'pages over budget', result ? `${over} of ${result.rows.length}` : `no result (exit ${s})`, '0', result && over === 0 ? 'pass' : 'FAIL');
    if (result) {
      const other = result.rows.reduce((n, r) => n + (r.otherThemeFiles || 0), 0);
      check('page-budget', 'files of another theme', `${other}${result.attributedScripts ? '' : ' (stylesheets only)'}`, '0', other ? 'FAIL' : 'pass');
    }
  }
}

console.log(`\nperf-suite  TARGET=${target}  ${steps.join(' → ')}`);
console.log(table([['step', 'check', 'number', 'budget', 'result'], ...rows]));
const failed = rows.filter((r) => r[4] === 'FAIL').length;
console.log(failed ? `perf-suite: FAIL (${failed} check${failed > 1 ? 's' : ''})` : 'perf-suite: pass');
process.exit(failed ? 1 : 0);
