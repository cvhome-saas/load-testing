# Signals: what the system emits, and where each comes from

The inventory of every metric family, log stream and span kind the platform produces, with the switch that controls
it. Names are as they appear in Prometheus (the collector renders OpenTelemetry names with `_` and a unit suffix);
the *OTel name* column is the provider-neutral name to look for on any other backend. Verified against a running
stack on 2026-09-06.

## Resource labels (on everything)

| label | value | note |
| --- | --- | --- |
| `service_name` | `catalog`, `checkout`, … the 12 Java services, `landing-ui`, `spg` | the join key across metrics, logs and traces |
| `service_version` | the build version (`2.0.0` for a release, `0.0.0-SNAPSHOT` locally) | `project.version` — `-Pversion` from the git tag in CI, `gradle.properties` otherwise — via `@version@` in `common-config.yml` |
| `service_instance_id` | UUID per process start | metrics and logs only; span metrics are keyed by service only |
| `application` | same as `service_name` | Micrometer's own tag; prefer `service_name` |

`host.name`, `host.arch`, `os.type` are dropped by the collector locally (`resource/trim`).

## Metrics

### HTTP server (every Java service) — Micrometer via the OTel bridge

| Prometheus name | OTel name | type | labels | meaning |
| --- | --- | --- | --- | --- |
| `http_server_requests_seconds_count` | `http.server.requests` | counter | `method`, `uri` (route template), `status`, `outcome`, `exception`, `error` | requests served |
| `http_server_requests_seconds_sum` | 〃 | counter | 〃 | total time |
| `http_server_requests_seconds_bucket` | 〃 | histogram | 〃 + `le` | buckets 50ms…10s (`management.metrics.distribution.slo`) |
| `http_server_requests_active_*` | `http.server.requests.active` | gauge/timer | `method`, `uri`, `status` | in-flight requests |

Requests rejected before routing (bare 401 from the JWT filter) carry `uri="UNKNOWN"`; health probes carry
`uri="/actuator/health"`. Every SLI excludes `uri=~"/actuator.*|UNKNOWN|root"`.
Switch: always on (Spring Boot actuator). Histogram buckets: `common-config.yml` → `management.metrics.distribution.slo`.

### HTTP client (outgoing calls) — OTel instrumentation

| Prometheus name                                           | OTel name                      | labels                                                                                            | meaning                            |
| --------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `http_client_request_duration_seconds_{count,sum,bucket}` | `http.client.request.duration` | `server_address`, `server_port`, `http_request_method`, `http_response_status_code`, `error_type` | calls made by WebClient/RestClient |

`error_type` is set (and the status label absent) when no HTTP answer came back — connection refused, timeout.

### Span metrics (derived from traces by the collector) — every service, spg, landing-ui

| Prometheus name | labels | meaning |
| --- | --- | --- |
| `traces_span_metrics_calls_total` | `service_name`, `span_name`, `span_kind` (`SPAN_KIND_SERVER`/`CLIENT`/`INTERNAL`), `status_code` (`STATUS_CODE_UNSET`/`OK`/`ERROR`), `http_request_method`, `http_route`, `http_response_status_code`, `error_type`, `db_system`, `db_operation`, `db_sql_table`, `server_address` | spans per name |
| `traces_span_metrics_duration_seconds_{count,sum,bucket}` | 〃 | span durations; buckets 5ms…10s |

Span names worth knowing: server spans `GET /api/v2/products/search` (route template), JDBC client spans
`SELECT catalog.product` / `INSERT checkout.sales_order` (`db_system="postgresql"`), scheduled work
`PartitionCoordinator.rebalance`, `OrderExpiryJob.expire`, spg routes `catalog`, `content`, `merchant`, `landing-ui`, …, landing-ui
page renders `GET /[locale]` and its upstream calls `fetch GET /catalog/api/v2/products/search` (query string and
ids stripped — `telemetry.ts` and the collector's `transform/span_names`).
Switch: collector `connectors.spanmetrics`.

### Service graph (derived from traces by the collector)

| Prometheus name | labels | meaning |
| --- | --- | --- |
| `traces_service_graph_request_total` | `client`, `server`, `connection_type`, `failed`, `http_response_status_code` | calls on an edge |
| `traces_service_graph_request_failed_total` | 〃 | failed calls |
| `traces_service_graph_request_server_seconds_*`, `_client_seconds_*` | 〃 | latency as seen by each side; buckets 10ms…10s |

`connection_type=""` is service-to-service, `"database"` the JDBC edge (`server="cvhome"`), `"virtual_node"` a peer
that sent no spans (`client="user"` for browsers/k6, `server="unknown"` for an uninstrumented host).
Switch: collector `connectors.servicegraph`.

### Database pool (every Java service) — Micrometer HikariCP

| Prometheus name | labels | meaning |
| --- | --- | --- |
| `hikaricp_connections`, `_active`, `_idle`, `_pending`, `_max`, `_min` | `pool` (= service name) | pool state; `pending` = threads waiting |
| `hikaricp_connections_timeout_total` | 〃 | requests that gave up waiting |
| `hikaricp_connections_acquire_seconds_*`, `_usage_seconds_*`, `_creation_seconds_*` | 〃 | time to get / hold / open a connection |
| `jdbc_connections_{active,idle,max,min}` | — | the same pool through the DataSource |

Switch: always on; pool size `spring.datasource.hikari.maximum-pool-size` (`lcl-config.yml`: 5).

### JVM (every Java service) — OTel runtime telemetry (semantic conventions)

| Prometheus name | labels | meaning |
| --- | --- | --- |
| `jvm_memory_used_bytes`, `_committed_bytes`, `_limit_bytes`, `_used_after_last_gc_bytes` | `jvm_memory_pool_name`, `jvm_memory_type` (`heap`/`non_heap`) | memory by pool |
| `jvm_gc_duration_seconds_{count,sum,bucket}` | `jvm_gc_name`, `jvm_gc_action` | collections and their pauses |
| `jvm_thread_count` | — | live threads |
| `jvm_cpu_recent_utilization_ratio`, `jvm_cpu_time_seconds_total`, `jvm_cpu_count` | — | CPU |
| `jvm_class_count`, `jvm_class_loaded_total`, `jvm_class_unloaded_total` | — | class loading |

Plus Micrometer's `process_cpu_usage`, `system_cpu_usage`, `system_cpu_count`, `system_load_average_1m`,
`process_files_{open,max}`, `process_uptime_seconds`, `process_start_time_seconds`.
Switch: OTel starter default; Micrometer's duplicate JVM set is off (`management.metrics.enable.jvm: false`).

### Tomcat and executors (every servlet service) — Micrometer

| Prometheus name | labels | meaning |
| --- | --- | --- |
| `tomcat_threads_busy`, `_current`, `_config_max` | — | request threads |
| `tomcat_connections_current`, `_config_max`, `_keepalive_current` | — | connector connections |
| `tomcat_global_request_count_total`, `_error_total`, `_received_bytes_total`, `_sent_bytes_total` | — | connector totals |
| `tomcat_sessions_*` | — | servlet sessions (uaa/cua) |
| `executor_active_threads`, `_queued_tasks`, `_pool_size_threads`, `_pool_core_threads`, `_pool_max_threads`, `_completed_tasks_total` | `name` | async and scheduler executors |

Switch: `server.tomcat.mbeanregistry.enabled: true` (`common-config.yml`); collector no longer drops `tomcat.*`/`executor.*`.

### Caches — Micrometer (Spring cache abstraction over Caffeine)

| Prometheus name | labels | meaning |
| --- | --- | --- |
| `cache_gets_total` | `cache`, `result` (`hit`/`miss`) | reads |
| `cache_size`, `cache_evictions_total`, `cache_puts_total` | `cache` | size and churn |

Switch: `spring.cache.caffeine.spec: recordStats` (`common-config.yml`). Hand-built Caffeine caches
(`StoreEntitlements`, `MerchantStoreOrgOwner`, secret-crypto) are not covered.

### cvhome's own meters

| Prometheus name | labels | meaning | source |
| --- | --- | --- | --- |
| `cvhome_auth_rejections_total` | `status` (401/403), `reason` (`invalid_token`, `missing_token`, `insufficient_scope`, `AccessDeniedException`, …), `source` (`filter`/`advice`), `uri` | why each 401/403 happened | `AuthRejectionMetricsFilter` (autoconfigure), every servlet service |
| `cvhome_outbox_records` | `status` | outbox rows by status | `OutboxMetrics`; services with `cvhome.metrics.outbox.enabled` (catalog, payment, billing, tenancy) |
| `cvhome_outbox_oldest_pending_seconds` | — | age of the oldest unfinished outbox row | 〃 |
| `cvhome_gateway_sessions` | — | seller sessions held in the gateway's memory | `GatewaySessionMetrics` (store-core-gateway) |

### Collector self-metrics

`otlp_exporter_seen_total`, `otlp_exporter_exported_total` (per exporter), `processedSpans_total`, `up{job="otel-collector"}`.

### k6 (load tests, remote-written by `load-testing/bin/k6run`)

| Prometheus name | labels | meaning |
| --- | --- | --- |
| `k6_http_reqs_total` | `testid`, `layer`, `profile`, `target`, `name` (endpoint, e.g. `catalog:product`), `store`, `method`, `status`, `expected_response`, `scenario` | requests sent |
| `k6_http_req_duration_{p95,p99,avg,max,min}` | 〃 | latency as the user saw it, in **seconds** |
| `k6_http_req_failed_rate` | 〃 | share of unexpected statuses |
| `k6_vus`, `k6_dropped_iterations_total`, `k6_iterations_total` | `testid` … | load shape |
| `k6_journey_duration_ms_p95`, `k6_journey_errors_rate` | `journey` | end-to-end user journeys (seconds despite the name) |
| `k6_orders_placed_total`, `k6_stores_created_total`, `k6_products_created_total`, `k6_shoppers_registered_total` | — | domain writes |
| `k6_browser_web_vital_{lcp,cls,inp,ttfb}_p75` | — | Web Vitals from browser runs |

## Logs (Loki)

Stream labels: `service_name`, `service_instance_id`. Structured metadata on every line: `severity_text`,
`detected_level`, `trace_id`, `span_id`, `scope_name` (the logger), `service_version`. The line itself is the plain
message. All 12 Java services log here through the OTel logback appender; landing-ui and spg do not send logs
(their stdout is in `.lcl/<stack>/logs/`).

The console/file line format carries the same ids: `[<trace_id>-<span_id>]` (`logging.pattern.correlation`). On
request threads `TraceContextMdcFilter` (autoconfigure) writes them into the real MDC — that is also where the
ProblemDetail `traceId` comes from; on every other thread the OTel starter's logback MDC appender (installed because
`opentelemetry-logback-mdc-1.0` is on the classpath) adds them to the event for the pattern.

Levels: `lcl` profile runs `com.asrevo`, `org.springframework.web` and `org.springframework.security` at DEBUG;
`fargate` runs INFO/WARN/WARN.

## Traces (Tempo)

One trace per request, across spg → landing-ui → pod services → PostgreSQL. Span attributes used by the dashboards
and TraceQL searches:

| attribute | on | example |
| --- | --- | --- |
| `resource.service.name` | every span | `catalog` |
| `span:kind` | every span | `server`, `client`, `internal` |
| `span.http.route`, `span.http.request.method`, `span.http.response.status_code`, `span.error.type` | HTTP server spans | `/api/v2/products/search`, `GET`, `404` |
| `span.server.address`, `span.url.path`, `span.url.full` | HTTP client spans | `localhost`, `/api/v1/store` |
| `span.db.system`, `span.db.operation`, `span.db.sql.table`, `span.db.name`, `span.db.statement` | JDBC client spans | `postgresql`, `SELECT`, `catalog.product`. The instrumentation sets `db.sql.table` only for single-table statements; the collector (`transform/span_names`) fills it from the first table after `FROM` / `INTO` / `UPDATE` in `db.statement` for joins and subqueries and renames the span from `SELECT cvhome` to `SELECT <table>` |
| `name` | scheduled work (`@Scheduled` methods) | `PartitionCoordinator.rebalance`, `OrderExpiryJob.expire`, `KeyRotationScheduler.tick` |

Only the OpenTelemetry starter produces spans; Spring Boot's Micrometer Tracing is excluded
(`spring.autoconfigure.exclude` in `common-config.yml`) because it produced a second, differently named span for
every request and every scheduled task.

## Switches, in one place

| what | where | value |
| --- | --- | --- |
| everything on/off | environment | `OTEL_SDK_DISABLED=false` (`otel.sdk.disabled` defaults to true) |
| export endpoints and protocol | `lcl.yml` → `SPRING_APPLICATION_JSON` | `otel.exporter.otlp.endpoint` = collector gRPC, `otel.exporter.otlp.protocol: grpc` |
| Micrometer → OTLP path | `common-config.yml` | `otel.instrumentation.micrometer.enabled: true`, `management.otlp.metrics.export.enabled: false` |
| latency buckets | `common-config.yml` | `management.metrics.distribution.slo.http.server.requests` |
| Tomcat meters | `common-config.yml` | `server.tomcat.mbeanregistry.enabled: true` |
| cache meters | `common-config.yml` | `spring.cache.caffeine.spec: recordStats` |
| outbox meters | each service's `application.yml` | `cvhome.metrics.outbox.enabled/table` |
| span-name hygiene | `landing-ui/storefront/src/shell/telemetry.ts`, collector `transform/span_names` | — |
| what the collector keeps | collector `filter/drop_metrics` | drops `spring.*`, `disk.*`, `logback.*`, `tasks.*`, `nodejs.*`, `v8js.*`, `processedLogs.*` |
