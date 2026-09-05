# Metrics in Prometheus

`bin/k6run` streams every sample to Prometheus with `--out experimental-prometheus-rw`. The endpoint comes from
`prometheusUrl` in `k6/config/env/<TARGET>.json` (`PROMETHEUS_URL` overrides it); `NO_PROM=1` skips the output.
Locally that is the stack's own Prometheus, started by `lcl start -d --infra all` with the remote-write receiver
on (`docker-compose-lcl.yml`). Grafana is at `http://localhost:3000` (anonymous admin), Prometheus at `:9090`.

## Labels every sample carries

| label | values | from |
|---|---|---|
| `testid` | `<script>-<profile>-<utc>` | `bin/k6run` (`TESTID` to pin one) |
| `layer` | storefront · shopper · admin · platform · browser · mixed · all | script directory |
| `target` | lcl · dev · … | `TARGET` |
| `profile` | smoke · load · stress · spike · soak · breakpoint | `PROFILE` |
| `name` | one per endpoint, e.g. `catalog:product`, `checkout:checkout`, `page:home` | every client method |
| `store` | store name (`org1-store1`, `k6-local`, …) or `none` | the edge |
| `scenario`, `method`, `status`, `expected_response`, `error_code` | k6 system tags | `K6_SYSTEM_TAGS` |

`url` is deliberately not a label: cart codes and order ids would create a series per request.
Custom metrics add `journey` (`journey_duration_ms`, `journey_errors`), `known` (`domain_lookups`).

Trends are exported as `_p95`, `_p99`, `_avg`, `_max`, `_min` (`K6_PROMETHEUS_RW_TREND_STATS`). Every time-typed trend is
converted to **seconds** on the way out — `k6_http_req_duration_*`, `k6_browser_web_vital_*` and the suite's own
`journey_duration_ms`, `shopper_auth_ms`, `seller_login_ms` alike (declared as time metrics, so the `_ms` suffix
describes the local summary only). Stale markers are off
(`K6_PROMETHEUS_RW_STALE_MARKERS=false`): with them on, every series ends when the run ends and an instant query
after the run returns nothing, which is confusing on a dashboard; use range queries either way.

## Queries

```promql
# throughput and latency of one run, per endpoint (trend stats are gauges per flush: use range forms,
# an instant query after the run only sees the last, near-empty flush)
sum by (name) (rate(k6_http_reqs_total{testid="$testid"}[1m]))
max by (name) (max_over_time(k6_http_req_duration_p95{testid="$testid"}[$__range]))

# the knee: requests/s flattening while p95 rises
sum(rate(k6_http_reqs_total{testid="$testid"}[30s]))
max(k6_http_req_duration_p95{testid="$testid", expected_response="true"})   # as a time series panel

# failures by endpoint and status (429 = limiter, 402 = billing guard, 5xx = the platform)
sum by (name, status) (rate(k6_http_reqs_total{testid="$testid", expected_response="false"}[1m]))

# open-model executors that could not keep up
k6_dropped_iterations_total{testid="$testid"}

# journeys, as a user experiences them
max by (journey) (max_over_time(k6_journey_duration_ms_p95{testid="$testid"}[$__range]))
sum by (journey) (rate(k6_journey_errors{testid="$testid"}[1m]))

# domain writes
k6_orders_placed_total{testid="$testid"}
k6_stores_created_total{testid="$testid"}

# browser
max(max_over_time(k6_browser_web_vital_lcp_p75{testid="$testid"}[$__range]))
```

## Application-side signals worth putting next to these

Locally the services do not export anything until `otel.sdk.disabled` is off (see the README prerequisites);
once they do, the collector exposes them on `otel-collector:8889` and these are the edges the suite is built to hit:

| signal | edge |
|---|---|
| `hikaricp_connections_pending` | database pool exhaustion (5 per service on lcl, 10 on Fargate) |
| `tomcat_threads_busy` vs `tomcat_threads_config_max` | request-thread saturation (dropped by the collector filter by default) |
| `jvm_memory_used_bytes` slope during soak | unbounded caches (catalog/checkout/payment `STORE` cache) |
| `pg_stat_activity` count | the single postgres behind twelve services |
| merchant `lookup-by-domain` span duration (Tempo) | spg domain-cache misses |
| uaa `request.rate_limited` audit events | the limiter engaging |
