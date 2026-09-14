#!/usr/bin/env node
// A deployed run's report: what ECS did during it, read-only from CloudWatch and the ECS API, next to k6's summary.
//
//   TARGET=aws make aws-report TESTID=<testid>        node scripts/aws-report.mjs <testid>
//
// For every ECS service of the target's clusters (awsRegion and ecsClusterPrefix in k6/config/env/<TARGET>.json):
// its task size, desired / running / pending tasks now, CPU and memory as one-minute maxima over the run (peak, and
// minutes at 90 %+), running-task counts over the run where Container Insights publishes them, scaling activities and
// service events in the window, and tasks stopped in it with their reason (ECS keeps a stopped task for about an hour,
// so run it soon after). Then k6's summary of the same run. It only reads (sts get-caller-identity, ecs list/describe,
// cloudwatch get-metric-data, application-autoscaling describe-scaling-activities) and needs AWS credentials: without
// them it says so and exits 2. The window is the run's, from Prometheus or the testid's stamp and results/<testid>.json,
// padded by AWS_REPORT_PAD_BEFORE (60 s) and AWS_REPORT_PAD_AFTER (300 s, the autoscaler's reaction).
// Also written to results/<testid>.aws-report.json.
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fmtDuration, fmtTime, root, runWindow, summaryOf, table, targetFile} from './lib/runs.mjs';

const testid = process.argv[2] || process.env.TESTID;
if (!testid) { console.error('usage: node scripts/aws-report.mjs <testid>   (or TESTID=…, with TARGET=aws)'); process.exit(2); }
const target = process.env.TARGET || 'aws';
const file = targetFile(target);
const region = process.env.AWS_REGION || file.awsRegion || process.env.AWS_DEFAULT_REGION;
const prefix = process.env.ECS_CLUSTER_PREFIX || file.ecsClusterPrefix;
if (!region || !prefix) { console.error(`aws-report: k6/config/env/${target}.json needs awsRegion and ecsClusterPrefix`); process.exit(2); }

function aws(args) {
  const out = execFileSync('aws', [...args, '--region', region, '--output', 'json'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024});
  return out.trim() ? JSON.parse(out) : {};
}
try {
  aws(['sts', 'get-caller-identity']);
} catch (e) {
  const lines = String(e.stderr || e.message).trim().split('\n').filter((l) => /error/i.test(l));
  const why = lines.sort((a, b) => b.length - a.length)[0] || 'aws sts get-caller-identity failed';
  console.log(`aws-report  ${testid}: no AWS credentials for ${region} (${why.replace(/\d{12}/g, '<account>')}). Sign in (aws sso login) and run it again; CloudWatch keeps the numbers, ECS keeps stopped tasks for about an hour.`);
  process.exit(2);
}

const [from, to] = await runWindow(testid);
const start = from - Number(process.env.AWS_REPORT_PAD_BEFORE || 60);
const end = Math.min(Math.floor(Date.now() / 1000), to + Number(process.env.AWS_REPORT_PAD_AFTER || 300));
const iso = (t) => new Date(t * 1000).toISOString();
const inWindow = (t) => { const s = new Date(t).getTime() / 1000; return s >= start && s <= end; };
const chunks = (list, n) => Array.from({length: Math.ceil(list.length / n)}, (_, i) => list.slice(i * n, i * n + n));

const clusters = (aws(['ecs', 'list-clusters']).clusterArns || []).map((a) => a.split('/').pop()).filter((c) => c.startsWith(prefix)).sort();
if (!clusters.length) { console.log(`aws-report: no ECS cluster named ${prefix}* in ${region}`); process.exit(2); }
const sizes = new Map();
const services = [];
const events = [];
for (const cluster of clusters) {
  const names = [];
  let token;
  do {
    const page = aws(['ecs', 'list-services', '--cluster', cluster, ...(token ? ['--next-token', token] : [])]);
    names.push(...(page.serviceArns || []).map((a) => a.split('/').pop()));
    token = page.nextToken;
  } while (token);
  for (const batch of chunks(names.sort(), 10)) {
    for (const s of aws(['ecs', 'describe-services', '--cluster', cluster, '--services', ...batch]).services || []) {
      if (!sizes.has(s.taskDefinition)) {
        const td = aws(['ecs', 'describe-task-definition', '--task-definition', s.taskDefinition]).taskDefinition;
        sizes.set(s.taskDefinition, `${Number(td.cpu) / 1024} vCPU ${td.memory} MiB`);
      }
      services.push({cluster, service: s.serviceName, size: sizes.get(s.taskDefinition), desired: s.desiredCount, running: s.runningCount, pending: s.pendingCount});
      for (const e of s.events || []) if (inWindow(e.createdAt)) events.push({at: e.createdAt, service: s.serviceName, what: e.message.replace(/^\(service [^)]+\) /, '')});
    }
  }
  // Tasks stopped in the window, with why.
  const stopped = aws(['ecs', 'list-tasks', '--cluster', cluster, '--desired-status', 'STOPPED']).taskArns || [];
  for (const batch of chunks(stopped, 100)) {
    for (const t of aws(['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', ...batch]).tasks || []) {
      if (!t.stoppedAt || !inWindow(t.stoppedAt)) continue;
      const containers = (t.containers || []).filter((c) => c.reason || c.exitCode).map((c) => `${c.name}: ${c.reason || `exit ${c.exitCode}`}`).join('; ');
      events.push({at: t.stoppedAt, service: (t.group || '').replace(/^service:/, ''), what: `task stopped: ${t.stoppedReason || t.stopCode}${containers ? ` (${containers})` : ''}`, stopped: true});
    }
  }
}
for (const a of aws(['application-autoscaling', 'describe-scaling-activities', '--service-namespace', 'ecs']).ScalingActivities || []) {
  const [, cluster, service] = a.ResourceId.split('/');
  if (clusters.includes(cluster) && inWindow(a.StartTime)) events.push({at: a.StartTime, service, what: `scaling: ${a.Description} (${a.StatusCode})`, scaling: true});
}

// CloudWatch, one-minute maxima: CPU and memory from AWS/ECS, task counts from Container Insights when it is on.
const queries = [];
services.forEach((s, i) => {
  const dims = [{Name: 'ClusterName', Value: s.cluster}, {Name: 'ServiceName', Value: s.service}];
  for (const [id, ns, metric, stat] of [['cpu', 'AWS/ECS', 'CPUUtilization', 'Maximum'], ['mem', 'AWS/ECS', 'MemoryUtilization', 'Maximum'],
    ['run', 'ECS/ContainerInsights', 'RunningTaskCount', 'Maximum'], ['pend', 'ECS/ContainerInsights', 'PendingTaskCount', 'Maximum']]) {
    queries.push({Id: `${id}${i}`, MetricStat: {Metric: {Namespace: ns, MetricName: metric, Dimensions: dims}, Period: 60, Stat: stat}, ReturnData: true});
  }
});
const series = {};
for (const batch of chunks(queries, 500)) {
  let token;
  do {
    const page = aws(['cloudwatch', 'get-metric-data', '--start-time', iso(start), '--end-time', iso(end), '--metric-data-queries', JSON.stringify(batch), ...(token ? ['--next-token', token] : [])]);
    for (const r of page.MetricDataResults || []) (series[r.Id] ||= []).push(...r.Values);
    token = page.NextToken;
  } while (token);
}
const peak = (v) => (v && v.length ? Math.max(...v) : null);
services.forEach((s, i) => {
  s.peakCpu = peak(series[`cpu${i}`]);
  s.minutesCpu90 = (series[`cpu${i}`] || []).filter((v) => v >= 90).length;
  s.peakMem = peak(series[`mem${i}`]);
  s.maxRunning = peak(series[`run${i}`]);
  s.maxPending = peak(series[`pend${i}`]);
  s.scaling = events.filter((e) => e.scaling && e.service === s.service).length;
  s.stopped = events.filter((e) => e.stopped && e.service === s.service).length;
});
const insights = services.some((s) => s.maxRunning !== null);

const p = (v) => (v === null ? '-' : `${Math.round(v)}%`);
console.log(`\naws-report  ${testid}  ${fmtTime(start)} → ${fmtTime(end).slice(11)} UTC (the run ${fmtDuration(to - from)}, padded)  ${region}  clusters: ${clusters.join(', ')}`);
console.log(table([['cluster', 'service', 'task size', 'desired/running/pending now', 'peak cpu', 'min ≥90% cpu', 'peak mem', ...(insights ? ['max running', 'max pending'] : []), 'scaling', 'stopped'],
  ...services.sort((a, b) => (b.peakCpu ?? -1) - (a.peakCpu ?? -1)).map((s) => [s.cluster.slice(prefix.length), s.service, s.size, `${s.desired}/${s.running}/${s.pending}`,
    p(s.peakCpu), s.minutesCpu90, p(s.peakMem), ...(insights ? [s.maxRunning ?? '-', s.maxPending ?? '-'] : []), s.scaling, s.stopped])]));
if (!insights) console.log('  running/pending over the run: no Container Insights in this environment (flavour monitoring=false); the events below show every task started or stopped');
console.log(`  events in the window (${events.length}):`);
events.sort((a, b) => new Date(a.at) - new Date(b.at)).slice(0, 60).forEach((e) => console.log(`    ${fmtTime(new Date(e.at).getTime() / 1000).slice(11)}  ${e.service.padEnd(20)} ${e.what}`));

const summary = summaryOf(testid);
if (summary) {
  const m = summary.metrics || {};
  const failedThresholds = Object.entries(m).flatMap(([name, v]) => Object.entries(v.thresholds || {}).filter(([, t]) => !t.ok).map(([expr]) => `${name} ${expr}`));
  console.log(`  k6: ${m.http_reqs?.values?.count ?? '-'} requests, ${((m.http_req_failed?.values?.rate ?? 0) * 100).toFixed(2)} % failed, ` +
    `p95 ${Math.round(m.http_req_duration?.values?.['p(95)'] ?? NaN)} ms, peak ${m.vus_max?.values?.max ?? '-'} VUs; ` +
    (failedThresholds.length ? `thresholds failed: ${failedThresholds.join(', ')}` : 'every threshold held'));
} else {
  console.log(`  k6: no results/${testid}.json here`);
}
mkdirSync(join(root, 'results'), {recursive: true});
writeFileSync(join(root, 'results', `${testid.replace(/[^A-Za-z0-9_.-]/g, '-')}.aws-report.json`), JSON.stringify({testid, region, clusters, from, to, start, end, services, events}, null, 2) + '\n');
