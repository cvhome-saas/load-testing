# Alerts

The alert rules in `stack/monitoring/prometheus-rules/cvhome-alerts.yml`, in words. Locally there is no
Alertmanager: firing alerts appear on the Platform Overview (*Firing alerts* table, *Firing alerts* stat) through the
`ALERTS` series. Deployed, the same rules can feed any Alertmanager-compatible receiver or be re-expressed as the
provider's alarms ([porting.md](porting.md)). Each entry: condition, how long it must hold, severity, what it usually
means, first steps, and how to silence it.

`page` = wake someone up · `ticket` = look at it today · `warn` = shown on the dashboard, no notification.

| alert | condition | for | severity |
| --- | --- | --- | --- |
| `CvhomeAvailabilityBurnFast` | 5xx burn rate > 14.4 over both 1 h and 5 m | 2 m | page |
| `CvhomeAvailabilityBurnSlow` | 5xx burn rate > 6 over both 6 h and 30 m | 15 m | ticket |
| `CvhomeLatencyStorefrontSlo` | storefront reads under 500 ms < 95 % | 5 m | warn |
| `CvhomeLatencyCheckoutSlo` | checkout/payment writes under 2 s < 95 % | 5 m | warn |
| `CvhomeS2sEdgeFailing` | a service→service edge fails > 5 % | 2 m | warn |
| `CvhomeHikariPending` | threads waiting for a DB connection > 0 | 1 m | warn |
| `CvhomeHikariTimeouts` | DB connection timeouts > 0 | 1 m | warn |
| `CvhomeTomcatSaturated` | request threads busy > 80 % | 2 m | warn |
| `CvhomeGcPressure` | GC pause share > 5 % or heap after GC > 85 % | 5 m | warn |
| `CvhomeSqlSlow` | SQL p99 > 500 ms | 5 m | warn |
| `CvhomeServiceSilent` | no metrics from a service for 90 s | 1 m | page |
| `CvhomeOutboxFailed` | outbox records in FAILED | 1 m | warn |
| `CvhomeOutboxStuck` | oldest pending outbox record > 5 min | 1 m | warn |

## CvhomeAvailabilityBurnFast / CvhomeAvailabilityBurnSlow

- **Means.** The service is failing requests fast enough to exhaust its monthly 0.1 % error budget in two days (fast) or in about five days (slow). Two windows must agree so a blip does not page and a slow leak does not hide.
- **First steps.** Service RED for `service_name` → *Failed routes* → trace → log line. If several services fire together, look at the database and Service-to-Service first: one failing dependency fans out.
- **Silence.** Fix or accept the burn; there is no muting locally. Deployed: an Alertmanager silence on `service_name`.

## CvhomeLatencyStorefrontSlo / CvhomeLatencyCheckoutSlo

- **Means.** More than 5 % of the customer-facing reads (writes) are slower than the SLO.
- **First steps.** Service RED → *Slowest routes* → *Slow traces*. Then Database & SQL (*Top statements*, *Statements per request*) and Bottlenecks (pool, threads). During a load test this is expected past the knee — read it with Load test vs app.

## CvhomeS2sEdgeFailing

- **Means.** One caller→callee pair is failing. The label pair names them.
- **First steps.** The callee's Service RED (is it answering 4xx/5xx?) and Service-to-Service → *Outgoing transport failures* (is it reachable at all?). A 4xx from the callee is a contract problem on the caller; `error_type` is the callee down or the discovery entry wrong (`lcl-config.yml` / Cloud Map).

## CvhomeHikariPending / CvhomeHikariTimeouts

- **Means.** The database connection pool is exhausted; requests queue on it (pending) or give up after 30 s (timeouts, which surface as 5xx).
- **First steps.** Database & SQL → *Time a connection is held* (long transactions?) and *Top statements* (a slow statement holding connections?). Check `pg_stat_activity` for lock waits. The pool is 5 locally / 10 deployed on purpose; raise it only with the numbers in hand.

## CvhomeTomcatSaturated

- **Means.** More than 80 % of the request threads are busy — usually busy waiting on something else.
- **First steps.** Bottlenecks → matrix: if the pool is also red, it is the pool; if Service-to-Service p95 is high, it is a dependency; if CPU is red, it is CPU. Raising threads alone moves the queue, it does not shorten it.

## CvhomeGcPressure

- **Means.** The JVM spends more than 5 % of its time in GC pauses, or keeps more than 85 % of its heap alive after collecting.
- **First steps.** JVM & Runtime → *Heap after GC vs limit*: a rising floor is a leak (heap dump, look for unbounded caches); a flat high floor needs a bigger heap.

## CvhomeSqlSlow

- **Means.** The slowest 1 % of SQL statements take over 500 ms.
- **First steps.** Database & SQL → *Top statements* → *Traces with this statement* → `db.statement` → `EXPLAIN`.

## CvhomeServiceSilent

- **Means.** A service has not exported metrics for 90 s: it is down, or its SDK is disabled, or the collector is unreachable.
- **First steps.** `lcl status --stack <name>` / the deployed task status; then `OTEL_SDK_DISABLED`; then Bottlenecks → *Telemetry pipeline*.

## CvhomeOutboxFailed / CvhomeOutboxStuck

- **Means.** An event was not delivered (FAILED) or has been waiting for more than five minutes (the scheduler is behind or stopped).
- **First steps.** Outbox & Events → *Failed background work* and *Outbox log lines*; `select id, record_type, failure_reason from <schema>.outbox_record where status='FAILED'`. Handlers are idempotent by rule, so a record can be reset to NEW once the cause is fixed.

## Adding an alert

1. Rule in `cvhome-alerts.yml` over a recording rule (never a raw query — the SLI must exist on a dashboard first).
2. A case in `tests/cvhome.test.yml` proving it fires and does not fire.
3. An entry here and, if it is a new SLI, in [kpis.md](kpis.md).
