# Porting the monitoring to another provider

Everything here is OpenTelemetry at the source: the services, spg and the storefront emit OTLP; the collector
routes it. Grafana, Prometheus, Loki and Tempo are one rendering. To move to CloudWatch, Datadog, Grafana Cloud,
New Relic, Honeycomb or any OTLP-capable backend, the application does not change; what changes is listed below,
and [kpis.md](kpis.md) + [dashboards.md](dashboards.md) contain every query to re-express.

## What stays

- The instrumentation and every attribute name (OTel semantic conventions): `service.name`, `http.route`,
  `http.response.status_code`, `db.system`, `db.operation`, `db.sql.table`, `server.address`, `error.type`, the
  JVM `jvm.*` metrics, Micrometer's `http.server.requests`, `hikaricp.*`, `tomcat.*`, `cache.*`, and cvhome's own
  `cvhome.auth.rejections`, `cvhome.outbox.*`, `cvhome.gateway.sessions`.
- The collector as the single egress: swap exporters, keep receivers, processors and the two connectors.
- The `trace_id` join: error body ↔ log line ↔ trace works on any backend that keeps the W3C trace id on log records
  (every OTLP log backend does).
- The KPI definitions, targets and alert conditions ([kpis.md](kpis.md), [alerts.md](alerts.md)).
- The k6 labels; k6 can write to any Prometheus remote-write endpoint (AMP, Grafana Cloud, Datadog's, …).

## What changes, by backend

| concern | Prometheus / Loki / Tempo (local) | AWS CloudWatch (the `aws-otel-collector` config in the platform repo) | Datadog / Grafana Cloud / other OTLP |
| --- | --- | --- | --- |
| collector exporters | `prometheus` (:8889), `otlphttp/loki`, `otlp/tempo` | `awsemf` (metrics), `awscloudwatchlogs`, `awsxray` (traces) — or AMP via `prometheusremotewrite` and OTLP to Application Signals | one `otlp`/`otlphttp` exporter with the vendor endpoint and API key |
| span-derived metrics | collector `spanmetrics` + `servicegraph` connectors | keep the connectors and export to AMP; or rely on Application Signals / X-Ray service map | keep the connectors, or use the vendor's APM (Datadog computes RED and the service map from spans natively) |
| metric names | `http_server_requests_seconds_bucket` (unit suffix, `_` separators) | EMF: `http.server.requests` with dimensions; AMP: same as local | Datadog: `http.server.requests` → `http.server.requests.bucket`/`count`; check the vendor's OTLP mapping doc |
| percentiles | `histogram_quantile(0.95, sum by (le) (rate(..._bucket[5m])))` | CloudWatch: `p95` statistic on the EMF metric (buckets are sent as a distribution); AMP: as local | Datadog: `p95:` on a distribution metric; others: their percentile function over histogram buckets |
| logs query | LogQL `{service_name="x"} \| detected_level="error"` | Logs Insights `fields @timestamp, body \| filter severity_text = "ERROR" and resource.service.name = "x"` | vendor log search on `service.name`, `severity_text`, `trace_id` |
| trace query | TraceQL `{resource.service.name="x" && span:kind=server && duration > 500ms}` | X-Ray filter expressions `service("x") AND duration > 0.5`; Application Signals SLOs | Datadog APM search `service:x @duration:>500ms`; vendor equivalents |
| recording rules | Prometheus `rule_files` | AMP rule groups (same YAML); CloudWatch metric math for the ratios | vendor "derived metrics"/"monitors" (Datadog monitors evaluate the ratio inline) |
| alerts | Prometheus alert rules + Alertmanager | CloudWatch alarms (metric math for ratios; composite alarms for the two-window burn) or AMP alert manager | vendor monitors; burn-rate monitors exist natively on Datadog and Grafana Cloud SLOs |
| dashboards | provisioned JSON from git | CloudWatch dashboards (JSON, via Terraform) — one widget per row of dashboards.md | vendor dashboards-as-code (Datadog Terraform provider, Grafana provisioning for Grafana Cloud unchanged) |
| exemplars | Prometheus exemplar storage → Tempo | not supported by CloudWatch metrics; X-Ray links from Application Signals | supported by Datadog (trace samples on distributions) and Grafana Cloud |

## Series-name translation

The local names are the OTel/Micrometer name with `.` → `_`, a unit suffix, and `_total` on counters. To find any
series on another backend, strip those. Examples:

| local | OTel name | attributes used |
| --- | --- | --- |
| `http_server_requests_seconds_{count,sum,bucket}` | `http.server.requests` (Micrometer timer) | `method`, `uri`, `status`, `outcome`, `exception` |
| `http_client_request_duration_seconds_*` | `http.client.request.duration` | `server.address`, `http.response.status_code`, `error.type` |
| `traces_span_metrics_calls_total` / `_duration_seconds_*` | `traces.span.metrics.calls` / `.duration` (collector) | `span.name`, `span.kind`, `status.code`, + configured dimensions |
| `traces_service_graph_request_*` | `traces.service.graph.request.*` (collector) | `client`, `server`, `connection_type`, `failed` |
| `hikaricp_connections_active` | `hikaricp.connections.active` | `pool` |
| `jvm_memory_used_after_last_gc_bytes` | `jvm.memory.used_after_last_gc` | `jvm.memory.type`, `jvm.memory.pool.name` |
| `tomcat_threads_busy` | `tomcat.threads.busy` | — |
| `cvhome_auth_rejections_total` | `cvhome.auth.rejections` | `status`, `reason`, `source`, `uri` |

## The two things that need care

1. **Histogram boundaries.** The SLO ratios read the `le="0.5"` and `le="2"` buckets. Whatever backend, keep those
   boundaries in the histogram configuration (`management.metrics.distribution.slo` for Micrometer, the collector's
   `spanmetrics.histogram.explicit.buckets`) or the "good ratio" KPIs cannot be computed exactly.
2. **Span-name hygiene.** The storefront's fetch spans are renamed at the source (`telemetry.ts`) and again in the
   collector (`transform/span_names`). Keep both when re-pointing the collector; a backend billed per series or per
   unique span name will notice within a day if they are lost.

## Suggested order

1. Point the collector's exporters at the new backend, keep everything else. Confirm the resource attributes and the
   `trace_id` on log records arrive.
2. Recreate the recording rules (or their equivalents) from [kpis.md](kpis.md) — each entry has the query and the
   OTel names it relies on.
3. Recreate the alerts from [alerts.md](alerts.md).
4. Rebuild the dashboards from [dashboards.md](dashboards.md), one panel per row; keep the same uids/titles so the
   runbooks stay valid.
5. Run `make smoke` from `load-testing` against the target and walk `qa/lcl-qa.md` case 15 with the new URLs.
