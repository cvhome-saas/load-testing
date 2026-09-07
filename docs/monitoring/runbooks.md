# Runbooks: from a symptom to the cause

Each scenario: what you see and on which panel, the drill path (metrics → traces → logs), the usual causes, and the
fix. Dashboard names are the Grafana ones; every panel's query is in [dashboards.md](dashboards.md), every number's
meaning in [kpis.md](kpis.md).

The general path, whatever the symptom:

1. **Platform Overview** — which service, since when, is it errors or latency, is anything else red at the same time.
2. **Service RED** for that service — which route, which status, which exception.
3. **A trace** — the latency panel's *Slow traces* link, or the *Failed routes* row link: where inside the request the time or the error is.
4. **The logs** — from the trace ("Logs for this span") or Logs & Errors filtered on the service: the stack trace.
5. **The resource** — Database & SQL, Service-to-Service, JVM & Runtime, Bottlenecks, depending on what the trace pointed at.

## Storefront is slow

- **See.** Platform Overview → *Storefront latency SLO* below 95 %, *p95 by service* rising for catalog/content/inventory/merchant or landing-ui.
- **Drill.** Edge → is it the page render (landing-ui) or one upstream call (*Upstream fetch p95 by call*)? Then that service's Service RED → *Slowest routes* → *Slow traces* → open the slowest.
- **Usual causes.** (a) One slow statement — the trace shows a long JDBC span: Database & SQL → *Top statements*, `EXPLAIN` it (missing index, unscoped filter). (b) Many statements — the trace shows dozens of short JDBC spans: an N+1; Database & SQL → *Statements per request*. (c) A slow dependency — the trace shows a long client span: Service-to-Service → that edge. (d) Nothing in the trace is slow but the request took long — it waited for a thread or a connection: Bottlenecks → *Request threads*, *Waiting for a connection*. (e) The storefront itself (dev server locally): Edge → *Page render p95* high while upstream fetches are fast.
- **Fix.** (a) index / query; (b) batch or join; (c) the callee's own runbook; (d) the saturation runbook below; (e) build the storefront (`next build`) before judging it.

## 5xx spike

- **See.** Platform Overview → *5xx ratio by service*, *Availability burn rate*; alert `CvhomeAvailabilityBurn*`.
- **Drill.** Service RED → *Failed routes* (route + exception class) → row link → a trace with `status=error` → "Logs for this span" → the stack trace. Logs & Errors → *Exception classes*, *Top error messages* for the aggregate view.
- **Usual causes.** A `RemoteServiceException` (a peer down — check Service-to-Service *Outgoing transport failures*), a `DataIntegrityViolation` (a schema/DDL mismatch after a deploy), a pool timeout (`SQLTransientConnectionException` — pool exhausted, see below), a NullPointer on a new code path (the stack trace).
- **Fix.** By cause. A single route failing 100 % since a deploy is a code bug; every route failing is infrastructure (database, discovery, collector) — check `lcl status` / task health first.

## Checkout is failing

- **See.** Service RED (checkout) → 422/409/5xx stats; Load test vs app → *k6 failures by endpoint* with `checkout:checkout`; Auth → 402 at the gateway.
- **Drill.** *Failed routes* → the status tells the story: 422 = a business refusal (out of stock, plan limit, provider refused — `providerCode` in the body); 409 = an optimistic-lock conflict (two buyers on the same stock row); 502 = the payment provider or inventory did not answer (`remoteService` in the body); 402 = the store's subscription lapsed (billing guard).
- **Usual causes.** Inventory reserve contention under load (row locks: Database & SQL → *Time a connection is held* high on inventory); the payment provider's sandbox rate-limiting; a trial store hitting its 50-orders cap (422 `plan_limit`).
- **Fix.** 409/lock contention is expected under `inventory-contention`; anything else, follow the status.

## Database pool exhausted

- **See.** Alert `CvhomeHikariPending`; Bottlenecks → *Waiting for a connection* > 0; Database & SQL → *Pool utilisation* red; latency rising on every route of one service with nothing slow inside the traces.
- **Drill.** Database & SQL → *Time a connection is held (p95)*: long holds with fast statements = a transaction held open while doing other work (an HTTP call inside a transaction, a big loop). *Top statements*: one slow statement holding connections. Traces → *Slow SQL*.
- **Usual causes.** An outbox handler or job doing remote calls inside `@Transactional`; a lock wait in PostgreSQL (`select * from pg_stat_activity where wait_event_type='Lock'`); simply more concurrent requests than 5 connections can serve (expected at the load-test knee).
- **Fix.** Shorten the transaction; fix the slow statement; then, with the numbers, raise `spring.datasource.hikari.maximum-pool-size` (10 on Fargate) — never first.

## Service-to-service calls failing

- **See.** Service-to-Service → *Failure share by edge* red, *Edges* table; alert `CvhomeS2sEdgeFailing`; the *Service map* edge red.
- **Drill.** *Outgoing transport failures* (`error_type` set): the callee is unreachable — down, or the discovery entry wrong. *Outgoing HTTP errors by destination*: the callee answered 4xx/5xx — its Service RED says why. Row link → the failed client spans → the callee's server span in the same trace.
- **Usual causes.** A callee that is restarting (`lcl status`); a missing `lcl-config.yml` / Cloud Map entry for a new service; an expired s2s client-credentials token (401 from the callee — Auth → `invalid_token` on the callee); a contract change (422/400 from the callee after one side deployed).
- **Fix.** By cause; the error rules in the repo say a refusal and a transport failure must not share a `catch`, so the caller's exception type already tells which.

## Auth failures (401 / 403)

- **See.** Auth → *401 / 403 by service*, *Rejections by reason*, *Bare 401s*; Service RED → 401/403 stats.
- **Drill.** The `reason`: `invalid_token` = expired or wrong issuer (which client? the `uri` and the calling service's *Outgoing HTTP errors*); `missing_token` = a call without a bearer (a frontend not sending it, k6 without a session); `AccessDeniedException` on one route = the permission token behind that endpoint has no `case` in `CustomPermissionEvaluator` or the principal lacks the role; `insufficient_scope` = the s2s client's scope. Bare 401s with `uri="UNKNOWN"` never reached routing: an issuer the resource server does not trust (`spring.security.oauth2.resourceserver.jwt.issuers`, the port in the issuer after a shifted stack).
- **Fix.** Token refresh on the client; the missing `case`; the issuer list.

## SQL slow or N+1

- **See.** Database & SQL → *Statement p95 by family* red, *Statements per request* > 10; alert `CvhomeSqlSlow`; Traces → *Statement-heavy requests* non-empty.
- **Drill.** *Top statements* → *Traces with this statement* → the span's `db.statement` is the SQL → `EXPLAIN (ANALYZE, BUFFERS)` in psql. For N+1: an *N+1 suspect* trace shows the repeated statement and the route above it.
- **Usual causes.** No index on the filter (store id + slug, sku); a `findAll` followed by per-item lookups in a populator; a lock wait (the statement is fast in isolation).
- **Fix.** The index in `schema.sql` (the source of DDL); a batch fetch or `JOIN FETCH`; shorter transactions.

## Outbox stuck

- **See.** Outbox & Events → *Oldest pending record* rising, *Outbox records by status* with FAILED > 0 or NEW growing; alerts `CvhomeOutbox*`.
- **Drill.** *Outbox polling / s* zero = the poller is not running (service down, or `namastack.outbox` disabled); *Outbox statement errors / s* > 0 or rows in FAILED = handlers throwing — *Failed background work* → the trace → the log line by `trace_id`; `select id, record_type, failure_count, failure_reason from <schema>.outbox_record where status='FAILED'`.
- **Usual causes.** A consumer service down (the event is retried with backoff — `next_retry_at`); a handler that is not idempotent and fails on redelivery; a payload the consumer no longer understands after a deploy.
- **Fix.** Bring the consumer back; fix the handler; reset the record (`update … set status='NEW', failure_count=0`) once the cause is gone — handlers are idempotent by rule.

## GC pressure or a memory leak

- **See.** JVM & Runtime → *GC pause share* > 5 %, *Heap after GC vs limit* rising through a soak; alert `CvhomeGcPressure`.
- **Drill.** *Heap used by pool*: which pool grows (Old Gen = retained objects). Bottlenecks → *Cache size and evictions*: an unbounded cache. Auth → sessions count (gateway) growing without logins ending.
- **Usual causes.** The `STORE` Caffeine cache without a maximum size; gateway sessions never expiring under a login-heavy test; a static map keyed by request.
- **Fix.** A heap dump (`/actuator/heapdump` — not on uaa, whose actuator is narrowed on purpose) and the dominator tree; then a bounded cache or a shorter session.

## Request threads saturated

- **See.** Bottlenecks → *Request thread utilisation* > 80 %; alert `CvhomeTomcatSaturated`; latency rising on every route, traces short.
- **Drill.** Threads are busy waiting: Bottlenecks matrix → is the pool red (then it is the pool), is Service-to-Service p95 high (then a dependency), is CPU red (then CPU).
- **Fix.** The thing they wait on. `server.tomcat.threads.max` only if CPU and the pool have headroom.

## The telemetry itself is missing

- **See.** Platform Overview → *Services reporting* < 12; a dashboard with "No data"; Loki empty; alert `CvhomeServiceSilent`.
- **Drill.** `lcl status --stack <name>` (is the process up?); was the stack started with `OTEL_SDK_DISABLED=false` (a restart keeps the old environment — stop and start); Bottlenecks → *Telemetry pipeline* (collector exporter seen vs exported, `up{job="otel-collector"}`); `lcl logs --errors --grep 'Failed to export'` (the http/protobuf-vs-gRPC mismatch); `docker logs <collector>` for a config error (the collector exits and takes the whole `--infra all` start with it).
- **Fix.** By cause; `qa/lcl-qa.md` case 15 is the checklist.
