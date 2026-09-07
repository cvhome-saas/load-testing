# Monitoring cvhome

This directory is the monitoring of the platform, end to end: what is measured, what "good" means, the dashboards
that show it, the alerts that fire when it is not, and what to do then. It is written so that someone who has never
opened Grafana can read it, and so that the whole setup can be rebuilt on another provider from the documents alone.

## Start here

| I want to… | read |
| --- | --- |
| understand the words (metric, trace, p95, SLO, error budget…) | [concepts.md](concepts.md) |
| know what each number means and when it is bad | [kpis.md](kpis.md) — one entry per KPI |
| know what every graph on every dashboard shows and the query behind it | [dashboards.md](dashboards.md) (generated) |
| know which alerts exist and what to do when one fires | [alerts.md](alerts.md) |
| fix something that is slow or failing right now | [runbooks.md](runbooks.md) |
| see what the system emits, where it comes from, and the switch that turns it on | [signals.md](signals.md) |
| read a load-test run against the application | [load-testing.md](load-testing.md) |
| move all of this to CloudWatch, Datadog or another OpenTelemetry backend | [porting.md](porting.md) |
| see what the first load tests found and what still has to be measured | [performance-improvements.md](performance-improvements.md) |

## Running it locally

```bash
make stack-up                                             # the stack plus collector, Prometheus, Loki, Tempo, Grafana
open http://localhost:3000                             # Grafana, anonymous admin; home page = Platform Overview
```

Ports shift by +1000 per extra `lcl` stack (`lcl ports --stack <name>`); Grafana's own port is fixed at 3000 in
`docker-compose-lcl.yml`. Telemetry is off unless `OTEL_SDK_DISABLED=false` is exported (every Java service, the
storefront and spg honour it).

## The three signals in one paragraph each

**Metrics** are numbers over time: requests per second, how many of them failed, how long the slowest 5 % took, how
full the database connection pool is. They are cheap, kept for weeks, and are what dashboards and alerts are built
on. Ours come from Micrometer inside each Java service (HTTP, pools, caches, Tomcat), from the OpenTelemetry runtime
(JVM), from k6 (load tests), and from the traces themselves (the collector turns every span into rate/error/latency
series and a service-to-service graph). They live in Prometheus.

**Traces** are the story of one request: the browser hit spg, spg forwarded to landing-ui, landing-ui called
catalog and inventory, catalog ran twelve SQL statements, one of them took 400 ms. Each step is a *span*; the whole
tree is a *trace*, identified by a `trace_id`. Traces are what you open when a metric says "slow" and you want to
know *where*. They live in Tempo.

**Logs** are what the services write as they work: errors with stack traces, warnings, the odd info line. Every log
line carries the `trace_id` of the request that produced it, so from an error line you can open the trace, and from
a trace you can list its log lines. The same `trace_id` is the `traceId` on every error response body, so a user's
screenshot of an error leads straight to the log line and the trace. They live in Loki.

## Where to click

- **Something is slow** → Platform Overview → the service whose p95 rose → Service RED (which route) →
  the latency panel's *Slow traces* link → one trace → the slow span (SQL? a downstream service? the service
  itself?). Then Database & SQL or Service-to-Service for the wider picture.
- **Something is failing** → Platform Overview → the service with the 5xx ratio → Service RED → the *Failed routes*
  table (which route, which exception) → its trace link → the *Logs* link for the stack trace.
- **Is it holding up under load?** → Bottlenecks: the saturation matrix says what is running out first
  (request threads, database pool, CPU, GC). During a k6 run, Load test vs app shows both sides on one time axis.
- **A user reported an error with an id** → Logs & Errors → search the id → *View trace*.

## How it fits together

```text
Java services ─┐  OTLP (gRPC 4317 / HTTP 4318)                     ┌─► Tempo  ── traces
landing-ui    ─┼──────────────────────────────► otel-collector ────┼─► Loki   ── logs
spg (Caddy)   ─┘                                 │ spanmetrics      └─► :8889  ── metrics ──► Prometheus ◄── k6 remote write
                                                 │ servicegraph                                   │ rules (SLIs, alerts)
                                                 └─────────────────────────────────────────────── Grafana (dashboards, provisioned from git)
```

Files:

| what | where |
| --- | --- |
| collector pipeline (what is kept, span-name hygiene, the two connectors) | `stack/monitoring/otel-collector.yml` |
| Prometheus scrape + rule files | `stack/monitoring/prometheus.yml`, `stack/monitoring/prometheus-rules/*.yml` (+ `tests/`) |
| Grafana data sources and the links between them | `stack/monitoring/grafana-datasources.yml` |
| dashboards (provisioned) | `stack/monitoring/grafana/dashboards/<folder>/<uid>.json`, provider `stack/monitoring/grafana-dashboards.yml` |
| dashboard source and generators | `stack/monitoring/scripts/dashboards.spec.mjs` → `build-dashboards.mjs`, `dashboard-docs.mjs` |
| application-side switches | `store-commons/autoconfigure/src/main/resources/common-config.yml` (`management.*`, `otel.*`, `logging.*`) |
| custom meters | `store-commons/autoconfigure/.../metrics/` (auth rejections, outbox), gateway `GatewaySessionMetrics` |
| trace id in the MDC and on error bodies | `store-commons/autoconfigure/.../tracing/TraceContextMdcFilter.java`, `errors/web/ProblemDetailFactory.java` |

## Changing a dashboard

1. Edit `stack/monitoring/scripts/dashboards.spec.mjs` — every panel is a helper call with a title, the question
   it answers, the query and its unit/thresholds.
2. `node stack/monitoring/scripts/build-dashboards.mjs && node stack/monitoring/scripts/dashboard-docs.mjs`
   regenerates the JSON and `docs/dashboards.md`. Grafana reloads the JSON within 10 s; the UI refuses edits
   (`allowUiUpdates: false`) so git stays the source.
3. Commit all three. CI runs both scripts with `--check` and fails on drift.

## Changing a KPI or an alert

Edit the rule in `stack/monitoring/prometheus-rules/`, add or adjust a case in `tests/cvhome.test.yml`, then update
the matching entry in [kpis.md](kpis.md) or [alerts.md](alerts.md) — those are written by hand, and the reviewer will
look for the pair.
