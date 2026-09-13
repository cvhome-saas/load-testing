// Shared by verdict.mjs, aws-report.mjs and perf-suite.mjs: where Prometheus answers, when a run happened, what the
// budgets say, and how to print a table.
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** k6/config/env/<TARGET>.json. */
export function targetFile(target = process.env.TARGET || 'local') {
  return JSON.parse(readFileSync(join(root, 'k6', 'config', 'env', `${target}.json`), 'utf8'));
}

/** Prometheus's query API: PROM_QUERY, else the target file's remote-write URL without /api/v1/write. */
export function promBase() {
  if (process.env.PROM_QUERY) return process.env.PROM_QUERY.replace(/\/$/, '');
  const write = process.env.PROMETHEUS_URL || targetFile().prometheusUrl || 'http://localhost:9090/api/v1/write';
  return write.replace(/\/api\/v1\/write\/?$/, '');
}

async function api(path, params) {
  const url = `${promBase()}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, {signal: AbortSignal.timeout(30000)});
  const body = await res.json().catch(() => ({}));
  if (body.status !== 'success') throw new Error(`prometheus ${path}: ${body.error || res.status} (${params.query})`);
  return body.data.result;
}

/** Instant query at `time` (epoch seconds): [{metric, value: [t, "v"]}]. */
export const query = (expr, time) => api('/api/v1/query', {query: expr, time: String(time)});

/** Range query: [{metric, values: [[t, "v"], ...]}]. */
export const range = (expr, start, end, step) =>
  api('/api/v1/query_range', {query: expr, start: String(start), end: String(end), step: String(step)});

/** Is Prometheus answering at all? */
export async function promUp() {
  try {
    return (await fetch(`${promBase()}/-/ready`, {signal: AbortSignal.timeout(3000)})).ok;
  } catch {
    return false;
  }
}

/** results/<testid>.json, k6's summary, when bin/k6run wrote one. */
export function summaryOf(testid) {
  const file = join(root, 'results', `${testid.replace(/[^A-Za-z0-9_.-]/g, '-')}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/**
 * The run's window, [from, to] in epoch seconds: VERDICT_FROM / VERDICT_TO when given (bin/k6run passes them), else
 * the first and last k6_vus sample of the testid in Prometheus, else the testid's UTC stamp plus the summary's
 * duration.
 */
export async function runWindow(testid) {
  if (process.env.VERDICT_FROM && process.env.VERDICT_TO) return [Number(process.env.VERDICT_FROM), Number(process.env.VERDICT_TO)];
  const now = Math.floor(Date.now() / 1000);
  const lookback = Number(process.env.VERDICT_LOOKBACK_HOURS || 72) * 3600;
  try {
    const coarse = await range(`max(timestamp(k6_vus{testid="${testid}"}))`, now - lookback, now, Math.ceil(lookback / 10000));
    const points = coarse[0]?.values.map(([, v]) => Number(v)) ?? [];
    if (points.length) return [Math.floor(Math.min(...points)), Math.ceil(Math.max(...points))];
  } catch { /* fall through to the stamp */ }
  const stamp = /(\d{8}T\d{6}Z)$/.exec(testid);
  const summary = summaryOf(testid);
  if (stamp && summary?.state?.testRunDurationMs) {
    const s = stamp[1];
    const from = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15)) / 1000;
    return [from, Math.ceil(from + summary.state.testRunDurationMs / 1000)];
  }
  throw new Error(`no window for ${testid}: not in Prometheus (last ${lookback / 3600} h) and no results/${testid}.json`);
}

/** k6/config/budgets.js read from Node. It is a k6 module of plain data, so it imports as an ES module from its text. */
export async function budgets() {
  const src = readFileSync(join(root, 'k6', 'config', 'budgets.js'), 'utf8');
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`);
}

export const fmtDuration = (s) => {
  const t = Math.round(s);
  return t >= 3600 ? `${Math.floor(t / 3600)}h${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}m`
    : t >= 60 ? `${Math.floor(t / 60)}m${String(t % 60).padStart(2, '0')}s` : `${t}s`;
};
export const fmtTime = (epoch) => new Date(epoch * 1000).toISOString().replace('T', ' ').slice(0, 19);
export const pct = (v) => (v === null || v === undefined || Number.isNaN(v) ? '-' : `${Math.round(v * 100)}%`);

/** Left-aligned text table: rows of strings, first row the header. */
export function table(rows, indent = '  ') {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i] ?? '').length)));
  return rows.map((r) => indent + r.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ').trimEnd()).join('\n');
}
