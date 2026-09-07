# KPIs and SLIs, one entry each

Every number the dashboards and alerts are built on. Each entry says what it means in plain words, why it matters,
how it is measured, the exact query (and the recording rule that computes it), the target with where the number
comes from, where it is shown, what to do when it goes red, and how to express it on another provider. Terms:
[concepts.md](concepts.md). Raw series and labels: [signals.md](signals.md).

Targets are the local-stack baseline, taken from `load-testing/k6/config/thresholds.js` where one exists; tighten
per environment once a baseline run has been recorded ([load-testing.md](load-testing.md)).

Legend for *Porting*: the OpenTelemetry (OTel) name and attributes the query relies on. Any backend that ingests
OTLP has them under its own spelling ([porting.md](porting.md)).

---

## Availability

### Availability (5xx ratio)

- **Meaning.** Share of requests we failed to serve. 99.9 % means one request in a thousand got a server error.
- **Why.** The single number that says "is it working". Every 5xx is a customer who could not do what they came for.
- **Measured.** From the HTTP server request counter, per service, 5-minute rate; health probes and unrouted requests excluded. 4xx do not count (they are the caller's problem — see *Client errors*).
- **Query.** `cvhome:http_server_errors:ratio_rate5m` = `(sum by (service_name) (rate(http_server_requests_seconds_count{status=~"5..",uri!~"/actuator.*|UNKNOWN|root"}[5m])) or sum by (service_name) (rate(http_server_requests_seconds_count{uri!~…}[5m])) * 0) / sum by (service_name) (rate(http_server_requests_seconds_count{uri!~…}[5m]))`
- **Target.** SLO 99.9 % → ratio ≤ 0.001. Amber 0.001, red 0.01.
- **Shown.** Platform Overview → *Availability (1h)*, *5xx ratio by service*, service table. Service RED → *5xx* stat, *Failed routes*.
- **When red.** Service RED for that service → *Failed routes* (which route, which exception) → trace link → the log line with the stack trace. If every service is red at once, look at the database (Database & SQL) or the collector/infra before the services.
- **Porting.** `http.server.requests` counter (Micrometer) with attributes `status`, `uri`; or the OTel `http.server.request.duration` histogram's count with `http.response.status_code`.

### Error budget burn rate

- **Meaning.** How fast the allowed 0.1 % of failures is being used up, relative to spending it exactly over a month. 1 = on budget; 14.4 sustained for an hour = the whole month's budget in two days.
- **Why.** Turns "some errors" into "how urgent": a short blip and a slow leak look the same on a 5xx graph but not here.
- **Measured.** 5xx ratio over four windows (5m, 30m, 1h, 6h) divided by 0.001.
- **Query.** `cvhome:slo_availability:burn_rate{5m,30m,1h,6h}`.
- **Target.** Fast burn: 1h > 14.4 **and** 5m > 14.4 → page. Slow burn: 6h > 6 **and** 30m > 6 → ticket.
- **Shown.** Platform Overview → *Availability burn rate*. Alerts `CvhomeAvailabilityBurnFast/Slow`.
- **When red.** Same path as availability; the window that is red says how long it has been going on.
- **Porting.** Same series as availability; the arithmetic is provider-agnostic.

### Services reporting

- **Meaning.** How many services sent metrics in the last two minutes.
- **Why.** A service that stopped exporting is down, or its SDK is off — either way its other KPIs are silently absent.
- **Query.** `count(count by (service_name) (process_uptime_seconds))`; per service `cvhome:service_last_seen:seconds` = `time() - max by (service_name) (timestamp(process_uptime_seconds))`.
- **Target.** 12 Java services locally. Alert `CvhomeServiceSilent` at > 90 s.
- **Shown.** Platform Overview → *Services reporting*.
- **When red.** `lcl status`; if the process is up, check `OTEL_SDK_DISABLED` and the collector (Bottlenecks → *Telemetry pipeline*).
- **Porting.** Any always-present gauge (`process.uptime`, OTel `process.uptime`) and the backend's "absent" or "no data" condition.

## Latency

### Request latency p95 / p99 per route

- **Meaning.** The response time that 95 % (99 %) of requests to a route beat over the last five minutes.
- **Why.** Averages hide the slow tail; the tail is what a customer waiting on the product page experiences.
- **Measured.** From the HTTP server latency histogram (buckets 50 ms … 10 s, chosen to match the targets), per service, method and route.
- **Query.** `cvhome:http_server_requests:p95_5m` = `histogram_quantile(0.95, sum by (service_name, method, uri, le) (rate(http_server_requests_seconds_bucket{uri!~"/actuator.*|UNKNOWN|root"}[5m])))`; `…:p99_5m` likewise.
- **Target (p95, from thresholds.js).** catalog product 500 ms · search 800 ms · products-by-category 600 ms · inventory availability 400 ms · content layout 500 ms · cart create/update 800 ms · checkout 2 s · admin GET 1 s · admin POST/PUT 2.5 s · login 2.5 s. Panels colour at 0.5 s (amber) and 2 s (red).
- **Shown.** Service RED → *Latency p50/p95/p99*, *Latency distribution*, *Slowest routes*. Platform Overview → *p95 by service*.
- **When red.** Service RED → *Slow traces* link on the latency panel → open the slowest trace → is the time in SQL (Database & SQL), in a downstream call (Service-to-Service), or in the service itself (CPU/GC on JVM & Runtime, threads on Bottlenecks)?
- **Porting.** `http.server.requests` histogram (Micrometer) or OTel `http.server.request.duration` with `http.route`; the provider's percentile function over buckets.

### Request latency p95 per service (from spans)

- **Meaning.** Same as above but per service and including spg and the storefront, which have no Micrometer.
- **Query.** `cvhome:span_server:p95_5m` = `histogram_quantile(0.95, sum by (service_name, le) (rate(traces_span_metrics_duration_seconds_bucket{span_kind="SPAN_KIND_SERVER"}[5m])))`.
- **Target.** 0.5 s amber, 2 s red.
- **Shown.** Platform Overview → *p95 latency by service*, service table. Edge → spg and landing-ui p95 panels.
- **Porting.** Span-derived RED metrics: the collector's `spanmetrics` connector produces them for any backend; Tempo/Grafana, Datadog APM and X-Ray/Application Signals compute the same from spans natively.

### Storefront latency SLO (good ratio)

- **Meaning.** Share of storefront reads (GETs on catalog, content, merchant, inventory) answered under 500 ms.
- **Why.** The customer-facing promise, as one number with a target, so it can have an error budget like availability.
- **Query.** `cvhome:slo_latency_storefront:good_ratio_rate5m` = `sum by (service_name) (rate(http_server_requests_seconds_bucket{le="0.5",method="GET",service_name=~"catalog|content|merchant|inventory",uri!~…}[5m])) / sum by (service_name) (rate(http_server_requests_seconds_count{method="GET",…}[5m]))`.
- **Target.** SLO 95 %. Amber 0.9, red below. Burn: `cvhome:slo_latency_storefront:burn_rate{5m,1h}` = (1 − good ratio) / 0.05.
- **Shown.** Platform Overview → *Storefront latency SLO*, *Storefront latency burn rate*. Alert `CvhomeLatencyStorefrontSlo`.
- **When red.** Service RED (catalog first) → *Slowest routes*; then Database & SQL → *Statements per request* and *Top statements*.
- **Porting.** The `le="0.5"` bucket must exist: keep the 500 ms boundary in the histogram configuration of any backend.

### Checkout latency SLO (good ratio)

- **Meaning.** Share of checkout and payment writes (POST/PUT) answered under 2 s.
- **Query.** `cvhome:slo_latency_checkout:good_ratio_rate5m` (bucket `le="2"`, `service_name=~"checkout|payment"`, `method=~"POST|PUT"`).
- **Target.** SLO 95 %. Alert `CvhomeLatencyCheckoutSlo`.
- **Shown.** Platform Overview → *Checkout latency SLO*.
- **When red.** Service RED (checkout) → Service-to-Service (inventory reserve, payment provider) → Database & SQL (row locks on stock: *Time a connection is held*).

## Traffic and errors by class

### Request rate

- **Meaning.** Requests per second, per service and per route.
- **Why.** The denominator of everything else, and the shape of load during a test; a drop to zero on one service while the others continue is a dead service.
- **Query.** `cvhome:http_server_requests:rate5m` = `sum by (service_name, method, uri, status) (rate(http_server_requests_seconds_count{uri!~…}[5m]))`.
- **Shown.** Platform Overview → *Requests / s by service*; Service RED → *Requests / s by route*.
- **Porting.** `http.server.requests` count.

### Client errors (4xx excluding auth)

- **Meaning.** Share of requests answered 400/404/409/422/429 — the caller asked for something we could not do as asked.
- **Why.** Not our failure, but a change is a signal: a new 400 after a frontend deploy, 409s under contention, 429s when the limiter engages.
- **Query.** `cvhome:http_server_4xx:ratio_rate5m` (`status=~"4..",status!~"401|403"`).
- **Target.** Tracked, no SLO. Per code, Service RED colours 400/404/409/422/429 amber at 50 and red at 200 per range.
- **Shown.** Service RED → the eight status stats and *Failed routes*.
- **When rising.** *Failed routes* names the route and the exception class; 422 with `plan_limit` is the trial cap, 429 is the rate limiter (Auth → *429 rate limited*).
- **Porting.** Same counter, status attribute.

### Auth rejections (401 / 403) and their reasons

- **Meaning.** Requests refused for a missing or invalid token (401) or a valid token without the permission (403), with why.
- **Why.** A 401 burst is a client with an expired or wrong-issuer token; a 403 burst after a deploy is usually a permission token with no `case` in `CustomPermissionEvaluator`, which denies silently. The plain HTTP counter shows the code but not the reason, and a bare 401 from the JWT filter has no route.
- **Query.** By code: `cvhome:http_server_auth_rejections:rate5m` = `sum by (service_name, status) (rate(http_server_requests_seconds_count{status=~"401|403"}[5m]))`. By reason: `sum by (service_name, status, reason, source) (rate(cvhome_auth_rejections_total[5m]))` — `reason` is `invalid_token` / `insufficient_scope` / `missing_token` from the bearer challenge, or the exception class from the advice; `source` is `filter` or `advice`.
- **Target.** Tracked; alert on step change only (not configured — add one once a baseline exists).
- **Shown.** Auth → *401 / 403 by service*, *Bare 401s*, *Rejections by reason*. Service RED → *401*, *403*, *Auth rejections / s*.
- **When rising.** `invalid_token` on one client → that client's token refresh; `AccessDeniedException` on one route → the permission token behind that endpoint; bare 401 with `uri="UNKNOWN"` → the request never reached routing (issuer mismatch: check `spring.security.oauth2.resourceserver.jwt.issuers`).
- **Porting.** `cvhome.auth.rejections` counter (Micrometer, ours) with `status`, `reason`, `source`, `uri`.

## Dependencies

### Service-to-service failure share per edge

- **Meaning.** Of the calls service A made to service B, the share that failed, for every A→B pair the traces have seen.
- **Why.** This is where "checkout is failing" turns into "because inventory is refusing its reserve call".
- **Measured.** From the collector's service graph, built from the client/server span pairs.
- **Query.** `cvhome:s2s_failed:ratio_rate5m` = `(sum by (client, server) (rate(traces_service_graph_request_failed_total{connection_type=""}[5m])) or …*0) / sum by (client, server) (rate(traces_service_graph_request_total{connection_type=""}[5m]))`.
- **Target.** < 0.5 %; amber 0.005, red 0.05. Alert `CvhomeS2sEdgeFailing` at > 5 % for 2 m.
- **Shown.** Service-to-Service → *Failure share by edge*, *Edges* table (row link to the failed client spans), *Service map*.
- **When red.** The server side of the edge: its Service RED → *Failed routes* (a 4xx from the callee is a contract problem; a transport failure shows in *Outgoing transport failures* as `error_type`).
- **Porting.** Span-derived service graph: the collector's `servicegraph` connector on any OTLP backend; Tempo metrics-generator, Datadog service map, X-Ray service map compute the same.

### Service-to-service latency p95 per edge

- **Meaning.** How long the caller waits for the callee, slow tail.
- **Query.** `cvhome:s2s:p95_5m` = `histogram_quantile(0.95, sum by (client, server, le) (rate(traces_service_graph_request_client_seconds_bucket{connection_type=""}[5m])))`.
- **Target.** 0.5 s amber, 2 s red.
- **Shown.** Service-to-Service → *p95 by edge (caller side)*, *Edges* table.
- **Porting.** Same as above.

### Outgoing HTTP errors and transport failures

- **Meaning.** From the caller's HTTP client: answers that were 4xx/5xx, and calls that got no answer at all (connection refused, timeout — `error_type`).
- **Why.** Distinguishes "the callee refused" (a 422 the caller must handle) from "the callee was unreachable" (a 502 `RemoteServiceException`). The repo's error rules require the two never to share a catch; this is where you see which one happened.
- **Query.** `cvhome:http_client_errors:rate5m` = `sum by (service_name, server_address, http_response_status_code) (rate(http_client_request_duration_seconds_count{http_response_status_code=~"4..|5.."}[5m]))`; transport: `…{error_type!=""}`.
- **Shown.** Service-to-Service → *Outgoing HTTP errors by destination*, *Outgoing transport failures*.
- **Porting.** OTel `http.client.request.duration` with `server.address`, `http.response.status_code`, `error.type`.

## Database

### Connection pool utilisation, waiting, timeouts, acquire time

- **Meaning.** Connections in use as a share of the pool; threads currently waiting for one; requests that gave up waiting; how long getting a connection takes at p95.
- **Why.** The pool is small (5 locally, 10 deployed) and shared by every request thread; it is the first thing to run out under load and the most common cause of "everything is slow but nothing is failing".
- **Query.** `cvhome:hikari_pool:utilisation` = `max by (service_name) (hikaricp_connections_active) / max by (service_name) (hikaricp_connections_max)`; `cvhome:hikari_pending:max` = `max by (service_name) (hikaricp_connections_pending)`; `cvhome:hikari_timeouts:rate5m` = `sum by (service_name) (rate(hikaricp_connections_timeout_total[5m]))`; `cvhome:hikari_acquire:p95_5m` = `histogram_quantile(0.95, sum by (service_name, le) (rate(hikaricp_connections_acquire_seconds_bucket[5m])))`.
- **Target.** Utilisation < 80 % (amber 0.6, red 0.8); pending = 0 (alert `CvhomeHikariPending` after 1 m); timeouts = 0 (alert `CvhomeHikariTimeouts`); acquire p95 < 10 ms (amber), 100 ms (red).
- **Shown.** Database & SQL → *Pool*, *Pool utilisation*, *Connection timeouts*, *Time to get a connection*. Bottlenecks → matrix, *Waiting for a connection*.
- **When red.** Database & SQL → *Time a connection is held* (long holds = long transactions or work done inside them) and *Top statements* (slow statements hold connections). Raising the pool hides the problem only until the database itself saturates.
- **Porting.** HikariCP meters `hikaricp.connections.*` (Micrometer); OTel semconv `db.client.connection.*` on newer agents.

### SQL latency p95 per statement family

- **Meaning.** Slow tail of each kind of statement ("SELECT catalog.product", "INSERT checkout.sales_order").
- **Why.** Names the slow query directly, without a database-side profiler.
- **Measured.** From the JDBC client spans, turned into a histogram by the collector, keyed by span name.
- **Query.** `cvhome:sql:p95_5m` = `histogram_quantile(0.95, sum by (service_name, span_name, le) (rate(traces_span_metrics_duration_seconds_bucket{span_kind="SPAN_KIND_CLIENT",db_system="postgresql"}[5m])))`; `cvhome:sql:p99_5m` per service.
- **Target.** p95 < 100 ms (amber), 500 ms (red). Alert `CvhomeSqlSlow` at p99 > 500 ms for 5 m.
- **Shown.** Database & SQL → *Statement p95 by family*, *Top statements*, *Statement latency distribution*. Traces → *Slow SQL*.
- **When red.** *Top statements* row → *Traces with this statement* → the `db.statement` attribute on the span is the SQL text → `EXPLAIN` it; usual causes: a missing index, a filter not scoped by store, a lock wait (see *Time a connection is held*).
- **Porting.** JDBC spans with `db.system`, `db.operation`, `db.sql.table` (OTel); Datadog/X-Ray show the same per-statement latency in their trace views; the spanmetrics connector produces the series for any Prometheus-compatible store.

### Statements per request (N+1 signal)

- **Meaning.** Average number of SQL statements each incoming request costs, per service.
- **Why.** A list endpoint that runs one query per item is fine at 10 items and fatal at 1,000; this catches it before the catalogue grows.
- **Query.** `cvhome:sql_per_request:ratio5m` = `sum by (service_name) (rate(traces_span_metrics_calls_total{span_kind="SPAN_KIND_CLIENT",db_system="postgresql"}[5m])) / sum by (service_name) (rate(traces_span_metrics_calls_total{span_kind="SPAN_KIND_SERVER"}[5m]))`.
- **Target.** < 10; amber 5, red 10.
- **Shown.** Database & SQL → *Statements per request*, *N+1 suspects* (traces with > 20 statements). Bottlenecks → matrix.
- **When red.** Open an N+1 suspect trace: the repeated statement is the one to batch or join.
- **Porting.** Ratio of client DB spans to server spans; any span store can compute it.

### SQL errors

- **Query.** `cvhome:sql_errors:rate5m` = `sum by (service_name, span_name) (rate(traces_span_metrics_calls_total{…db_system="postgresql",status_code="STATUS_CODE_ERROR"}[5m]))`.
- **Shown.** Database & SQL → *Top statements* (errors/s column).
- **Porting.** JDBC spans with error status.

## Saturation

### Request thread utilisation (Tomcat)

- **Meaning.** Busy request threads as a share of the maximum (200 by default).
- **Why.** At 100 % new requests queue in the connector; latency climbs while no single request looks slow. The knee of every load test is either here or in the pool.
- **Query.** `cvhome:tomcat_threads:utilisation` = `max by (service_name) (tomcat_threads_busy) / max by (service_name) (tomcat_threads_config_max)`.
- **Target.** < 80 %; alert `CvhomeTomcatSaturated` at > 80 % for 2 m.
- **Shown.** Bottlenecks → *Request threads*, matrix. Load test vs app → *Saturation*.
- **When red.** Threads are busy *waiting* on something — the pool (pending > 0), a downstream call (Service-to-Service p95), or CPU. Raising `server.tomcat.threads.max` only helps if CPU and the pool have headroom.
- **Porting.** `tomcat.threads.*` (Micrometer, needs the MBean registry); on other servers the equivalent worker-pool gauges.

### CPU

- **Query.** `cvhome:jvm_cpu:ratio` = `max by (service_name) (jvm_cpu_recent_utilization_ratio)`; machine: `system_cpu_usage`, `system_load_average_1m`.
- **Target.** < 80 %; amber 0.6, red 0.8. (Locally all services share one machine, so the system line matters as much as any process.)
- **Shown.** JVM & Runtime → *CPU*, *Load average*. Bottlenecks → matrix.
- **Porting.** OTel `jvm.cpu.recent_utilization`; `process.cpu.utilization`.

### GC pause share and heap after GC

- **Meaning.** Share of wall time the JVM was paused collecting garbage; live heap after the last collection as a share of the limit.
- **Why.** GC share above 5 % is CPU stolen from requests; heap-after-GC creeping up through a soak is a memory leak, and above 85 % the JVM spends its life collecting.
- **Query.** `cvhome:jvm_gc_pause:ratio5m` = `sum by (service_name) (rate(jvm_gc_duration_seconds_sum{jvm_gc_action=~".*pause.*"}[5m]))`; `cvhome:jvm_heap_after_gc:ratio` = `sum by (service_name) (jvm_memory_used_after_last_gc_bytes{jvm_memory_type="heap"}) / sum by (service_name) (jvm_memory_limit_bytes{jvm_memory_type="heap"})`.
- **Target.** GC share < 5 % (amber 2 %); heap after GC < 85 % (amber 70 %). Alert `CvhomeGcPressure`.
- **Shown.** JVM & Runtime → *GC pause share*, *Heap after GC vs limit*, *Heap used by pool*. Load test vs app → *Heap after GC*.
- **When red.** A rising floor during a soak: take a heap dump (`/actuator/heapdump`, not on uaa) and look for the unbounded cache (`STORE` cache in catalog/checkout/payment, gateway sessions). A flat but high floor: a bigger heap.
- **Porting.** OTel JVM semconv `jvm.gc.duration`, `jvm.memory.used_after_last_gc`, `jvm.memory.limit`.

### Cache hit ratio

- **Query.** `sum by (service_name, cache) (rate(cache_gets_total{result="hit"}[5m])) / sum by (service_name, cache) (rate(cache_gets_total[5m]))`.
- **Target.** Depends on the cache; the `STORE` cache should be near 100 % in steady state.
- **Shown.** Bottlenecks → *Cache hit ratio*, *Cache size and evictions*.
- **Porting.** Micrometer `cache.*`.

### Executor queues

- **Query.** `sum by (service_name, name) (executor_queued_tasks)`, `executor_active_threads`.
- **Shown.** Bottlenecks → *Executor pools*. A growing queue is work arriving faster than it is done.
- **Porting.** Micrometer `executor.*`.

## Events

### Outbox backlog, oldest pending, failed

- **Meaning.** Records waiting in each service's outbox by status; the age of the oldest unfinished one; failed ones.
- **Why.** Events between services go through the outbox; a backlog is stale data downstream, a FAILED record is an event that was never delivered.
- **Query.** `max by (service_name, status) (cvhome_outbox_records)`; `max by (service_name) (cvhome_outbox_oldest_pending_seconds)`. Poller behaviour from the JDBC spans on the outbox tables: `rate(traces_span_metrics_calls_total{span_kind="SPAN_KIND_CLIENT",db_sql_table=~"outbox_.*"}[5m])` and their p95/error rate (the poller is not a `@Scheduled` method, so it has no span of its own).
- **Target.** FAILED = 0 (alert `CvhomeOutboxFailed`); oldest pending < 5 min (alert `CvhomeOutboxStuck`); an outbox statement p95 under the 2 s poll interval.
- **Shown.** Outbox & Events.
- **When red.** `select * from <schema>.outbox_record where status='FAILED'` → `failure_reason`; the handler's exception is in the *Failed background work* table and in the logs joined by `trace_id`.
- **Porting.** `cvhome.outbox.*` gauges (ours) — provider-neutral by construction.

## Edge

### spg per-route rate, p95, status

- **Query.** `sum by (span_name) (rate(traces_span_metrics_calls_total{service_name="spg",span_kind="SPAN_KIND_SERVER"}[5m]))` and the matching p95 / `http_response_status_code` splits.
- **Shown.** Edge → *spg* row. Target as the storefront SLO (0.5 s) plus the upstream's own time.
- **Porting.** Caddy's OTel spans; any span store.

### Storefront render p95 and upstream fetch p95

- **Query.** `histogram_quantile(0.95, sum by (span_name, le) (rate(traces_span_metrics_duration_seconds_bucket{service_name="landing-ui",span_kind="SPAN_KIND_SERVER"}[5m])))`; upstream: `…span_kind="SPAN_KIND_CLIENT",span_name=~"fetch .*"`.
- **Target.** Page render 3 s (thresholds.js `page:*`; dev server locally), upstream 0.5 s.
- **Shown.** Edge → *landing-ui* row.
- **Porting.** Next.js OTel spans (`GET /[locale]`, `fetch GET /path`).

### Web Vitals (from k6 browser runs)

- **Query.** `max_over_time(k6_browser_web_vital_{lcp,cls,inp,ttfb}_p75[$__range])`.
- **Target.** LCP < 4 s, CLS < 0.1, INP < 200 ms, TTFB < 1.5 s (thresholds.js, local).
- **Shown.** Edge → *Browser* row; Load test vs app.

## Gateway

### Seller sessions in memory

- **Query.** `max(cvhome_gateway_sessions)`.
- **Why.** Sessions are in the JVM: the count is capacity under a login-heavy test and the number of sellers a restart signs out.
- **Shown.** Auth → *Gateway sign-in and session*.

## Load test (k6 side)

### k6 request rate, p95 per endpoint, failed share, dropped iterations, journeys

- **Query.** `sum(rate(k6_http_reqs_total{testid="$testid"}[30s]))`; `max by (name) (k6_http_req_duration_p95{testid="$testid",expected_response="true"})`; `max(k6_http_req_failed_rate{testid="$testid"})`; `sum(k6_dropped_iterations_total{testid="$testid"})`; `max by (journey) (k6_journey_duration_ms_p95{testid="$testid"})`.
- **Target.** From `thresholds.js` per endpoint name; failed < 1 %; dropped < 10; journey p95 (purchase) < 5 s.
- **Shown.** Load test vs app; Bottlenecks → *Traffic vs p95* (VUs overlay).
- **Reading.** Dropped iterations > 0 means the load generator, not the app, ran out of VUs — raise `PEAK_VUS`/pre-allocated VUs before blaming the app. See [load-testing.md](load-testing.md).
