# Metrics in Prometheus

`bin/k6run` streams every sample to Prometheus with `--out experimental-prometheus-rw`. The endpoint comes from
`prometheusUrl` in `k6/config/env/<TARGET>.json` (`PROMETHEUS_URL` overrides it); `NO_PROM=1` skips the output.
Locally that is the stack's own Prometheus, started by `lcl start -d --infra all` with the remote-write receiver
on (`docker-compose-lcl.yml`). Grafana is at `http://localhost:3000` (anonymous admin), Prometheus at `:9090`.

## Labels every sample carries

| label                                                             | values                                                                     | from                              |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------- |
| `testid`                                                          | `<script>-<profile>-<utc>`                                                 | `bin/k6run` (`TESTID` to pin one) |
| `layer`                                                           | storefront · shopper · admin · platform · browser · mixed · all            | script directory                  |
| `target`                                                          | lcl · dev · …                                                              | `TARGET`                          |
| `profile`                                                         | smoke · load · stress · spike · soak · breakpoint                          | `PROFILE`                         |
| `name`                                                            | one per endpoint, e.g. `catalog:product`, `checkout:checkout`, `page:home` | every client method               |
| `store`                                                           | store name (`org1-store1`, `k6-local`, …) or `none`                        | the edge                          |
| `scenario`, `method`, `status`, `expected_response`, `error_code` | k6 system tags                                                             | `K6_SYSTEM_TAGS`                  |

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

## Dashboards

The application repo provisions Grafana dashboards (`../cvhome/extra/monitoring/grafana/dashboards`, documented panel
by panel in `../cvhome/extra/monitoring/docs/dashboards.md`). The one built for these runs is **Load test vs app**
(`/d/cvhome-load-test-vs-app`): pick the run in its _Test run_ variable (`testid`), and read k6's side (VUs, rate, p95
per `name`, failures by status, journeys) above the application's (rate, p95, 5xx, service-to-service failures,
then every saturation ratio — request threads, database pool, CPU, GC — on one axis). `make dash` opens it for
`TESTID` or the newest `results/*.json`.

`bin/k6run` also posts a Grafana annotation (tags `k6`, `testid:<id>`, `profile:<p>`, `layer:<l>`) at start and closes
it at exit, so every run is a shaded region on every dashboard. `grafanaUrl` comes from the deployment file
(`GRAFANA_URL` overrides, `NO_GRAFANA=1` skips). How to read a run and what to record:
`../cvhome/extra/monitoring/docs/load-testing.md`; the meaning of every application number:
`../cvhome/extra/monitoring/docs/kpis.md`.

## Application-side signals worth putting next to these

Locally the services export once the stack is started with `OTEL_SDK_DISABLED=false lcl start -d --infra all`;
the collector exposes them on `otel-collector:8889` and the recording rules in `../cvhome/extra/monitoring/prometheus-rules`
compute the SLIs. These are the edges the suite is built to hit:

| signal                                                                                    | edge                                                                        |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `cvhome:hikari_pending:max` (`hikaricp_connections_pending`)                              | database pool exhaustion (5 per service on lcl, 10 on Fargate)              |
| `cvhome:tomcat_threads:utilisation` (`tomcat_threads_busy` / `tomcat_threads_config_max`) | request-thread saturation                                                   |
| `cvhome:jvm_heap_after_gc:ratio` slope during soak                                        | unbounded caches (catalog/checkout/payment `STORE` cache), gateway sessions |
| `cvhome:sql_per_request:ratio5m`, `cvhome:sql:p95_5m`                                     | N+1 and slow statements                                                     |
| `cvhome:s2s_failed:ratio_rate5m`                                                          | a dependency giving up under load                                           |
| spg span `merchant` p95 (Edge dashboard)                                                  | spg domain-cache misses                                                     |
| `cvhome_auth_rejections_total{reason="rate_limited"}` / status 429                        | the limiter engaging                                                        |
