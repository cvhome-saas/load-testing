# QA — load-testing suite

The operator's path through the k6 suite: validating scripts without traffic, checking the target, running the
client self-test and a smoke run against a cvhome stack, finding where a run's results and Grafana annotation
land, and removing what the suite created.

- **Scope** — the make targets, `bin/k6run`, `scripts/preflight.sh`, `scripts/cleanup.sh`, the `k6-<RUN_ID>`
  fixtures, results and metrics output. Not the SLO numbers themselves (those are tuned per target).
- **Runs on** — `brew install k6` (2.2.0), `npm ci`; for anything that sends traffic,
  `make stack-up` (the platform's prebuilt images plus Prometheus, Grafana, collector, Tempo; telemetry on by default).
- **Cases** — 9 (0 verified, 9 not verified)
- **Also see** — `../cvhome` `qa/` for the application behaviour the journeys drive; `docs/prometheus.md` for
  reading a run; `docs/coverage.md` for which endpoint each client method hits.

Each case is tagged **[verified]** (run end to end and passed) or **[not verified]** (never run by anyone —
where the bugs are).

## 00 — Before you start

- `k6 version` prints 2.2.x; `node --version` is 20.19+; `npm ci` done in this repo.
- For 02–04: the load stack is up (`make stack-ps` shows every container running, `make stack-up` printed
  "every Java service is UP"), and the ports match
  `k6/config/env/local.json` (gateway `:8000`, uaa `:8001`, pod domain `spg-507f1f77.gateway.com`). If a second
  stack shifted the ports, edit a copy of the env file, not the committed one.
- `TARGET` defaults to `local`, `PROFILE` to `smoke`, `RUN_ID` to `local` — so the fixture store is `k6-local`.

## 01 — validation without traffic

### 01.1 make inspect parses every script [not verified]
- Setup: no stack needed.
- Steps: `make inspect`; then break an import in any `k6/scripts/**/*.js` and run it again; revert.
- Expect: one `ok` line per script under `k6/scripts/` (top-level `smoke`, `selftest`, `fixtures`, `cleanup` and
  every `<layer>/<name>`), exit 0, no HTTP request made. With the broken import: that script prints `FAIL`, the
  k6 error follows, exit 1, and the loop stops there.

### 01.2 the full local gate matches CI [not verified]
- Setup: `npm ci`.
- Steps: `npm test` (or `scripts/verify.sh`); then `ls build/k6/local/`.
- Expect: npm audit at `high`, ESLint, Prettier, Markdownlint, ShellCheck, actionlint, `make inspect` and
  `make build` all pass; `build/k6/local/` holds one `.tar` archive per script mirroring `k6/scripts/`. A missing
  `shellcheck`/`actionlint` prints `! <tool> not installed; skipping` and passes locally; with `CI=true` it fails.
  `scripts/verify.sh` ends with a receipt line and `git push` is then allowed for that exact tree.

## 02 — is the target up

### 02.1 make preflight against a running stack [not verified]
- Setup: the stack up as in 00.
- Steps: `make preflight`; then stop one service (`docker compose -p cvhome-load stop catalog`) and run it again; start it.
- Expect: with everything up, ✓ lines for gateway console, gateway health, uaa public login settings, storefront
  home, catalog through spg, "spg refuses an unknown sub-domain" (404 or 307), Prometheus ready, and the k6
  version; exit 0. With `catalog` down: the catalog probe prints `✗ … -> 000/502 (want 200)` and the script exits 1.
  Without Prometheus: a `!` warning naming `make stack-up` / `NO_PROM=1`, not a failure.

## 03 — running against the stack

### 03.1 make selftest covers every client method once [not verified]
- Setup: stack up, `make preflight` green.
- Steps: `make selftest` (it sets `NO_PROM=1` itself); read the summary.
- Expect: every client method runs once through `expect.soft`, so one run reports every broken contract instead
  of stopping at the first; checks summary lists each `service:endpoint` name; exit 0 when all pass. A failing
  method shows its name and expected vs actual status, and the run still completes. No `k6-` store is created.

### 03.2 one smoke run, and where the results land [not verified]
- Setup: stack up with Prometheus and Grafana (`--infra all`); note the time.
- Steps: `make smoke`; watch the first `k6run  script=… testid=…` line; after it ends: `ls -t results/ | head -1`;
  `make prom-check TESTID=<that testid>`; `make dash` (or `make dash TESTID=<testid>`); in Grafana, open any
  dashboard over the last hour.
- Expect: `bin/k6run` prints `script=k6/scripts/smoke.js layer=all profile=smoke target=local run_id=local
  testid=smoke-smoke-<UTC stamp>` and runs with `--out experimental-prometheus-rw`. Every journey runs one
  iteration; `setup()` provisions the `k6-local` org/store/catalogue (first run only, reused afterwards) and the
  run places orders on it. `results/<testid>.json` exists. `prom-check` returns a non-empty
  `sum(k6_http_reqs_total{testid="…"})` result. `dash` prints and opens
  `<grafanaUrl>/d/cvhome-load-test-vs-app?var-testid=<testid>…`; the run appears as a shaded region annotation
  tagged `k6`, `testid:<id>`, `profile:smoke`, `layer:all` from its start to its end on every dashboard.

### 03.3 a run stays local with NO_PROM / NO_GRAFANA [not verified]
- Setup: stack up; Prometheus may be down.
- Steps: `NO_PROM=1 NO_GRAFANA=1 PROFILE=smoke make storefront-browse`.
- Expect: the k6run line shows no `--out`, no annotation is posted, `results/<testid>.json` is still written, and
  `make prom-check TESTID=<testid>` returns an empty result.

### 03.4 a per-script target honours PROFILE and the knobs [not verified]
- Setup: stack up.
- Steps: `make knobs`; `make shopper-cart PROFILE=smoke`; `make shopper-cart PROFILE=load RATE=5 DURATION=30s`.
- Expect: `knobs` lists every `__ENV` knob with default and doc (`RATE`, `DURATION`, `PEAK_VUS`, …). The smoke run
  is one iteration; the load run is an open model at 5 req/s for 30 s, its `testid` is `cart-load-<stamp>`, and
  the thresholds from `k6/config/thresholds.js` for the `shopper` layer are evaluated in the summary.

## 04 — cleanup

### 04.1 make clean removes the k6- fixtures [not verified]
- Setup: at least one run with fixtures done (03.2); in the console, note the `k6-local` org and store, and the
  postgres container name (`docker ps`).
- Steps: `make clean`; then in the console/API list stores and orgs; then `make smoke` again.
- Expect: the API pass archives and deletes every `k6-` store as a seller would; the SQL pass runs
  `scripts/cleanup.sql` through the postgres container and removes what no API deletes (orders, carts, shoppers,
  orgs named `k6-`). Seeded demo stores (`org1-store1`, …) are untouched. The next `make smoke` provisions
  `k6-local` afresh instead of stopping on the reserved name. With the stack down: the API pass prints
  `! API pass failed (stack down?) — continuing with SQL`; with no postgres container: `! no postgres container
  found; skip SQL pass`, exit 0.

## REG — regression watchlist

- `KEEP_FIXTURES=false` soft-deletes the store but its name stays reserved: the next run with the same `RUN_ID`
  stops until `make clean` has run its SQL pass. Expected, documented in the README; watch for a run that hangs
  in `setup()` on a "store exists" error.
- The `url` system tag must stay dropped (`K6_SYSTEM_TAGS` in `bin/k6run`); its return explodes Prometheus
  series cardinality.

## 99 — known gaps

- `TARGET=local` numbers are dev-server numbers (`next dev`, Angular dev server, `gradle bootRun`); use
  `extra/scripts/load-stack.sh` in `../cvhome` for numbers that say something about a deployment.
- The fixture store is a trial store: 25 products and 50 orders a month; a long checkout run meets the cap
  (`plan_limit_hits`). Registration and account tests use the seeded stores because the trial store refuses
  shopper self-registration.
- Product photos 404 locally (MinIO has no volume); `BROWSER_BLOCK_IMAGES=1` keeps them out of browser failure
  rates.
- `Run k6 tests` with `target=local` needs a self-hosted runner (`K6_RUNNER`); a hosted runner refuses it.

## 05 — The load stack (`stack/`)

### 05.1 `make stack-up` brings the platform up as its images [verified 2026-09-08, local images `latest`]
- Setup: images exist locally (`docker images | grep store-`, from `./gradlew bootBuildImage` in `../cvhome`) or `LOAD_REGISTRY`/`LOAD_TAG` point at a registry; no `lcl` dev stack on the ports
- Steps: `make stack-up`; `make stack-ps`; `make stack-stats`
- Expect: "every Java service is UP" within `LOAD_WAIT` (600 s); 12 JVMs + console-ui + landing-ui + spg + postgres + minio + the monitoring five running; every container `/ 1GiB`; `http://localhost:3000` shows the platform overview with application metrics (telemetry is on by default)

### 05.2 The suite runs against it unchanged [verified 2026-09-08: preflight all ✓, smoke 298 requests 0 failed 2 orders; the one red check is the known first `spg:domain-lookup`]
- Steps: `make preflight`; `make smoke`
- Expect: preflight all ✓ including Prometheus; smoke provisions `k6-local` and passes; `make dash` shows the run with the *What the application did* rows populated

### 05.3 `make stack-down` keeps data, `make stack-down-hard` drops it [not verified]
- Steps: `make stack-down` then `make stack-up`: the `k6-local` store still exists; `make stack-down-hard` then `make stack-up`: it does not
- Expect: no `cvhome-load-*` containers after either down; volumes `cvhome-load_postgres-data` / `minio-data` only survive the soft down

### 05.5 The stack runs the native images at 512 MB [verified 2026-09-11: native images of cvhome-saas/cvhome#349, smoke 302 requests 0 failed, the four baseline scripts 0 failed, no restart; `docs/baseline.md`]
- Setup: in `../cvhome`, `./gradlew bootBuildImage -Pnative` (Docker Desktop at 24 GB or more: one native compile peaks near 12 GB), then `docker tag store-pod/catalog:latest store-pod/catalog:native` and so on for the twelve Spring images; spg, console-ui and landing-ui are tagged `:native` as they are
- Steps: `LOAD_TAG=native LOAD_MEM=512m make stack-up`; `make stack-stats`; `make preflight`; `make smoke`; `make storefront-browse PROFILE=load PEAK_VUS=30 DURATION=3m`
- Expect: every Java service UP within seconds of its container starting; each at 90–170 MiB idle, under 350 MiB in the breakpoint; all twelve in Prometheus (`count by (service_name) ({service_name=~".+"})`) — a native image of a version before the telemetry fix exports nothing; smoke as on the JVM images
- Expected to differ: the JVM gauges (`jvm_heap_after_gc`, `jvm_gc_pause`) are absent and `jvm_cpu` is unreliable for a native service — read `make stack-stats`

### 05.4 `make monitoring-check` guards the monitoring configuration [verified 2026-09-08: 12 dashboards, 46 rules, tests, collector, compose all pass]
- Steps: edit a dashboard JSON by hand; `make monitoring-check`
- Expect: `build-dashboards.mjs --check` fails naming the file; regenerating from the spec makes it pass; promtool rule tests and the collector `validate` pass
