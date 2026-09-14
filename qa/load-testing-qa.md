# QA — load-testing suite

The operator's path through the k6 suite: validating scripts without traffic, checking the target, running the
client self-test and a smoke run against a cvhome stack, finding where a run's results and Grafana annotation
land, and removing what the suite created.

- **Scope** — the make targets, `bin/k6run`, `scripts/preflight.sh`, `scripts/cleanup.sh`, the `k6-<RUN_ID>`
  fixtures, results and metrics output. Not the SLO numbers themselves (those are tuned per target).
- **Runs on** — `brew install k6` (2.2.0), `npm ci`; for anything that sends traffic,
  `make stack-up` (the platform's prebuilt images plus Prometheus, Grafana, collector, Tempo; telemetry on by default).
- **Cases** — 31 (22 verified, 9 not verified; 06.10 for its no-credentials path only)
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

### 03.5 make admin-store-settings loads the console's store settings screen [verified 2026-09-13 on dev (AWS), `TARGET=aws STORES=org1-store2`: smoke 31 requests 0 failed; load PEAK_VUS=10 3m 6,114 requests 0 failed]

- Setup: a target with the seeded org1 accounts (stack up, or `TARGET=aws` where the flavour sets `test_stores`);
  on dev, `aws.json` carries the seeded passwords.
- Steps: `make admin-store-settings PROFILE=smoke`; then `make admin-store-settings PROFILE=load PEAK_VUS=10 DURATION=3m`.
- Expect: one iteration is `gateway:store-management` (the client-rendered shell of `/store-management/domain`)
  and the ten reads the screen makes, every one 200: `merchant:store-private`, `tenancy:themes`,
  `tenancy:color-themes`, `tenancy:social-link-providers`, `merchant:languages`, `merchant:allocates`,
  `tenancy:saas-properties`, `tenancy:store-pod`, `payment:supported-types-private`, `payment:configurations`;
  `journey_errors{journey:store-settings}` is 0.

### 03.6 STORES=org1-store2 browses its own catalogue [verified 2026-09-13 on dev (AWS): browse load PEAK_VUS=30 3m, 2,442 requests 0 failed]

- Why: the storefront journeys browsed org1-store1's seed on every store, so on org1-store2 every category and
  product answered 404 (29 % of a browse run). `k6/data/seed-org1-store2.json` is org1-store2's seeded catalogue;
  `catalogFor()` picks a store's own seed and falls back to org1-store1's.
- Steps: `make storefront-browse STORES=org1-store2 PROFILE=smoke`.
- Expect: `catalog:category`, `catalog:product`, `page:category` and `page:product` all 200; `journey_errors` 0.

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
- Expect: "every Java service is UP" within `LOAD_WAIT` (900 s; 600 s when this was verified); 12 JVMs + console-ui + landing-ui + spg + postgres + minio + the monitoring running; the containers at their flavour's sizes since 06.1 (every container `/ 1GiB` when this was verified); `http://localhost:3000` shows the platform overview with application metrics (telemetry is on by default)

### 05.2 The suite runs against it unchanged [verified 2026-09-08: preflight all ✓, smoke 298 requests 0 failed 2 orders; the one red check is the known first `spg:domain-lookup`]

- Steps: `make preflight`; `make smoke`
- Expect: preflight all ✓ including Prometheus; smoke provisions `k6-local` and passes; `make dash` shows the run with the _What the application did_ rows populated

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

### 05.6 Every infra and monitoring image still pulls from its registry [verified 2026-09-12: all seven pulled; minio from quay.io started under the stack's own definition, 1 GiB limit, bucket created]

- Why: an image the stack does not build can vanish from its registry. Docker Hub stopped serving `minio/minio` (an anonymous manifest fetch answers 401), so `make stack-up` failed on any host without it cached; the stack now pulls the same release from `quay.io/minio/minio`, with the same index digest (`sha256:13582eff…d883`) and the same pin as cvhome's `docker-compose-lcl.yml`
- Steps: `docker compose -p cvhome-load-verify -f stack/docker-compose.yml pull postgres minio otel-collector loki tempo prometheus grafana`; then, with nothing on port 9000 needed, `docker compose -p cvhome-load-verify -f stack/docker-compose.yml run -d --rm --no-deps --name cvhome-load-verify-minio minio` and `docker exec cvhome-load-verify-minio sh -c 'mc alias set local http://localhost:9000 minioadmin minioadmin && mc ready local'`; finally `docker rm -f cvhome-load-verify-minio` and `docker compose -p cvhome-load-verify -f stack/docker-compose.yml down -v`
- Expect: every pull ends `Pulled`; MinIO reports `The cluster 'local' is ready`; nothing named `cvhome-load-verify*` left behind
- Not covered: the platform's own images (`store-core/*`, `store-pod/*`), which are a local pre-step or come from `LOAD_REGISTRY`

### 05.7 The JVMs log at a Fargate task's levels, and `LOAD_LOG_LEVEL=DEBUG` brings lcl's back [verified 2026-09-14: `config` both ways, 12 services each; `stack/stack.sh up` from this branch, then `smoke-smoke-20260914T103410Z` (298 requests, 0 failed) and 0 DEBUG lines in all twelve JVM logs]

- Why: the JVMs run the `lcl` profile for its discovery, and its DEBUG levels wrote 128–285 lines a request under load
  (`docs/baseline.md`, *Heavy spikes*)
- Steps:
  1. `docker compose -f stack/docker-compose.yml config | grep LOGGING_LEVEL`, then the same with `LOAD_LOG_LEVEL=DEBUG`
  2. `make stack-up`, `make smoke`, then `docker logs cvhome-load-inventory-1 2>&1 | grep -c ' DEBUG '`
- Expect:
  - Twelve services with `com.asrevo` at INFO and Spring web and security at WARN; all three at DEBUG with the knob
  - No DEBUG line in any JVM's log after the smoke

## 06 — AWS-like limits, verdicts and the heavier suite

### 06.1 `LOAD_FLAVOUR` holds every container to its Fargate size [verified 2026-09-14: `make stack-up` then `docker inspect` of every `cvhome-load-*` container, at 0.45 and at 0.65]

- Setup: images as in 05.1; a `../cvhome-platform` checkout beside this repo (or `CVHOME_PLATFORM`)
- Steps: `make stack-sizes`; `make stack-up`; `make stack-limits`; `docker inspect -f '{{.Name}} {{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}' $(docker ps -q --filter name=cvhome-load-)`
- Expect: the table shows dev's sizes × `LOAD_CPU_FACTOR` 0.45: landing-ui, catalog, content, merchant, spg and store-core-gateway at `0.225` cpus; uaa, tenancy, billing, pod-registry, checkout, cua, payment, inventory and console-ui at `0.1125`; postgres at `0.9` (db.t4g.micro); every JVM 1024m and console-ui 512m; minio has no CPU cap; the monitoring six are uncapped. `NanoCpus` is the cap × 10⁹ (`225000000` for landing-ui) and `Memory` the limit in bytes (`1073741824`); `LOAD_POOL_SIZE` defaults to 3
- Seen: exactly that at 0.45 (`NanoCpus` 225000000 / 112500000 / 900000000, `Memory` 1073741824, console-ui 536870912, the monitoring `0`); the same shape at 0.65 (325000000 / 162500000 / 1300000000). `make stack-limits` printed the same, with `dev/0.45` as each capped container's shape

### 06.2 Other shapes: staging, prod, off, `LOAD_MEM`, a bad value [verified 2026-09-14: `stack/stack.sh sizes` with each]

- Steps: `LOAD_FLAVOUR=prod make stack-sizes`; `LOAD_FLAVOUR=staging make stack-sizes`; `LOAD_FLAVOUR=off make stack-sizes`; `LOAD_MEM=512m make stack-sizes`; `LOAD_FLAVOUR=bogus make stack-sizes`; `LOAD_CPU_FACTOR=x make stack-sizes`
- Expect:
  - prod: medium at `0.45` cpus with 2048m, uaa at `0.225`, postgres db.t4g.small at 2048m, pool 6.
  - staging: console-ui `0.225` cpus at 1024m.
  - off: no CPU cap and 1g everywhere, pool 10.
  - `LOAD_MEM`: replaces every memory.
  - A bad flavour or factor: stops with the list of valid values, exit 1.
- Not run: a whole stack started at `prod` or `off`. Only the resolved table was checked.

### 06.3 The copied sizes cannot go stale [verified 2026-09-14: `node scripts/sync-fargate-sizes.mjs --check` against an edited copy, then `make sizes-sync`]

- Steps: `node scripts/sync-fargate-sizes.mjs --check`; change one number in `stack/fargate-sizes.json`; run it again; `make sizes-sync`; `CVHOME_PLATFORM=/nonexistent node scripts/sync-fargate-sizes.mjs --check`
- Expect: "matches"; then "stale … run node scripts/sync-fargate-sizes.mjs", exit 1; after the sync, matches again and the file is byte-identical to the committed one; with no platform checkout, "skipped", exit 0 (CI). The copy also agreed with PyYAML's reading of both platform files (16 services × 4 flavours)

### 06.4 Containers are in Prometheus and on Load test vs app [verified 2026-09-14: the cadvisor target up; the rules and every new panel's query answered from Prometheus; the panels were not opened in a browser]

- Setup: the stack up (06.1)
- Steps: `curl -s localhost:9090/api/v1/targets` (job `cadvisor`); query `load:container_cpu_limit:cores`, `load:container_memory_limit:bytes`; run any load; take each *What ran out* panel's query from `/api/dashboards/uid/cvhome-load-test-vs-app` and run it
- Expect: the cadvisor target is up; one series per capped service with its cap in cores (0.1125–0.9) and its limit in bytes; the new panels' queries answer (16 CPU series, 17 memory, landing-ui's `nodejs_eventloop_delay_p99_seconds` and `v8js_memory_heap_*`)
- Seen on the way: gcr.io's cAdvisor v0.52.1 saw bare cgroups only under Docker Desktop's containerd image store; 0.55.1 with the docker and containerd sockets names every container

### 06.5 Every run ends with a verdict [verified 2026-09-14: `load-load-20260914T011020Z` (verdict FAIL on landing-ui), `make verdict`, `NO_VERDICT=1` and `VERDICT=1` smoke runs, Prometheus down]

- Steps: `make storefront-browse PROFILE=load PEAK_VUS=30 DURATION=3m STORES=org1-store2`; then `make verdict` (the newest run) and `make verdict TESTID=<that testid>`; a smoke run with `NO_VERDICT=1` and one with `VERDICT=1`; `node scripts/verdict.mjs <testid>` with Prometheus stopped
- Expect:
  - After k6's summary, the verdict table per container: cap, peak CPU/cap, time and longest stretch at 90 %+, throttled share, memory limit and peak, OOM kills, restarts.
  - landing-ui's CPU per page view, in ms here and in Fargate ms.
  - k6's crossed thresholds, then "verdict: containers pass" or "FAIL" with each broken budget.
  - A broken budget fails the run. `results/<testid>.verdict.json` holds the same.
  - `NO_VERDICT=1` prints no verdict. A smoke run prints none unless `VERDICT=1`. With Prometheus down: "skipped", exit 0.

### 06.6 `storefront-page-breakpoint` finds landing-ui's knee [verified 2026-09-14: `page-breakpoint-breakpoint-20260914T012303Z`]

- Steps: `make storefront-page-breakpoint STORES=org1-store2` (breakpoint shape whatever `PROFILE` is but smoke)
- Expect: page views ramp from 1/s towards `PAGE_MAX_RPS` (20) over `RAMP`; a page's p95 passes 3 s and the run aborts 30 s later
- Seen: aborted after 1m58s on `page:home` p95 3.2 s, at about 3.8 page views/s offered at dev's size

### 06.7 A spike carries a recovery probe [verified 2026-09-14: `spike-spike-20260914T011845Z`]

- Steps: `make storefront-browse PROFILE=spike PEAK_VUS=10 STORES=org1-store2`
- Expect: scenarios `probe` (0 → 1m50s) and `recovery` (2m10s → 3m50s) beside `shoppers`; the summary has `http_req_duration{scenario:recovery}` held to p(95) < 3000; other profiles have no probe (`k6 inspect -e PROFILE=load` shows `shoppers` only)
- Seen: recovery p95 0.92 s, 0 failed, while the spike itself pushed pages to a 60 s p95

### 06.8 `platform-sign-in-burst` times each hop [verified 2026-09-14: `sign-in-burst-load-20260914T012522Z` and `make selftest`]

- Steps: `make platform-sign-in-burst PROFILE=load DURATION=3m`; `make selftest`
- Expect: 9 sign-ins a minute (`SIGNIN_RATE`); `seller:login-start`, `-submit`, `-authorize`, `-callback` each in the summary; the verdict prints uaa's CPU per sign-in. Every other script that signs in (the session pools) still gets its sessions: `make selftest` 102 of 102 checks
- Seen: the hops and uaa's CPU per sign-in were all reported. The local uaa (the old native image) could not keep up even at 9 a minute: at its cap for 2m45s, sign-in p95 98 s. That is the image, not the script (docs/baseline.md)

### 06.9 `make page-budget` checks what a page ships [verified 2026-09-14: perf-suite's page budget on landing-ui main after #356 (48 of 48 pass), and `PAGE_BUDGET_THEMES=fashion,basic,grocery` on the old `store-pod/landing-ui:native` (12 of 12 fail)]

- Steps: `make page-budget`; `PAGE_BUDGET_THEMES=fashion,basic make page-budget`
- Expect:
  - One row per theme × page (home, category, product, search): status 200, the theme it rendered, HTML (gzip), inline RSC, navigation RSC, CSS and JS files/KiB, files of another theme, duplicated inline CSS.
  - Scripts are attributed through the manifests copied out of the landing-ui container.
  - Exit 1 when a page is over a budget in `PAGE`.
- Seen:
  - The old image failed on every page: 11 scripts of another theme, 288 KiB of inline CSS twice, HTML 700–846 KiB.
  - The current build passed, with 0 files of another theme.

### 06.10 `make aws-report` reads ECS, and says so without credentials [verified 2026-09-14 for the no-credentials path only; not verified against AWS: the SSO session had expired]

- Steps: without an AWS session, `TARGET=aws make aws-report TESTID=<an aws run>`; with one (`aws sso login`), again
- Expect: without: one line "no AWS credentials for eu-north-1 (…)", exit 2, no other AWS call. With: per ECS service of `cvhome-dev-*`, task size, desired/running/pending, peak CPU and memory and minutes at 90 %+, scaling activities, service events and stopped tasks in the window, then k6's summary
- Seen: the no-credentials line and exit 2. The report itself has never run against AWS

### 06.11 `make perf-suite` runs everything and ends with one table [verified 2026-09-14: `LOAD_TAG=native LOAD_TAG_LANDING_UI=calib-arm64 make perf-suite`, 01:09–01:40 UTC]

- Steps: `make perf-suite` (about 35 minutes); `SUITE_STEPS=load,page-budget make perf-suite`
- Expect: stack-up, then smoke, load, spike, page breakpoint, sign-in burst, soak and the page budget run in order, each with its own testid and verdict; the final table lists every check with its number, budget and pass/fail; exit 1 when any check failed
- Seen: every step ran and the table came out, with 25 failed checks on this image set (docs/baseline.md). `SUITE_STEPS` was not run on its own

## 07 — The storefront spike in a browser

### 07.1 The storefront's static files come from MinIO, as from CloudFront [verified 2026-09-14: `LOAD_TAG=native`, landing-ui the amd64 `:native` image of 2026-09-13]

- Setup: `make stack-down`, then `make stack-up`
- Steps:
  1. Read the line `landing-ui static files:` that `make stack-up` prints.
  2. `curl -s http://org1-store2.spg-507f1f77.gateway.com/en | grep -o 'http://localhost:9000/storefront-assets/storefront/_next/static/[^"]*' | head -3`
  3. `LOAD_CDN=false make stack-up`, then the same two steps.
- Expect: `asset prefix set to http://localhost:9000/storefront-assets/storefront`, and a page's scripts point at MinIO
  and answer 200 from it. With `LOAD_CDN=false`: `asset prefix set to ''` and origin-relative `/_next/static`.
  `minio-init` exits 0 and landing-ui starts after it.
- Seen:
  - First boot: "Bucket created", "uploaded 173 files", and the prefix set. A home visit loaded its scripts from
    `localhost:9000`; the old image inlines its CSS, so its two fonts still came from landing-ui.
  - `LOAD_CDN=false`: prefix `''`, and 906 origin-relative `/_next/static` references.
  - Back to the CDN: "already synced — skipping upload".
  - In origin mode the page still sends a preconnect hint to the MinIO URL. landing-ui's layout reads
    `STATIC_ASSETS_BASE_URL` whether or not the files were synced. It is harmless: a preconnect nothing uses.

### 07.2 A browser's metrics carry its journey and no 3-second HTTPS attempt [verified 2026-09-14: `storefront-spike-smoke-20260914T064318Z`]

- Steps: `PROFILE=smoke STORES=org1-store2 make browser-storefront-spike`, then in Prometheus
  `max by (journey, resource_type, status) (k6_browser_http_req_duration_max{testid="<testid>"})`
- Expect: every series has `journey="visit-<page>"` and a `resource_type`, no `url` or per-URL `name`, and no Document
  with status 307. `browser_page_views` is 1, and `browser_web_vital_ttfb` is the render, not 3 s more.
- Seen: every series was `journey="visit-product"` with a `resource_type`; the Document answered 200 with no 307.
  With the HTTPS-Upgrades feature still on, the same home page had a TTFB of 3.86 s; with it off, 0.96 s.

### 07.3 `browser-storefront-spike` measures three windows of the spike [verified 2026-09-14: `PEAK_VUS=10` on cvhome main's landing-ui (a local arm64 image), `storefront-spike-spike-20260914T071803Z` and `…T072333Z`; mechanics first on the old images]

- Steps: `make browser-storefront-spike PROFILE=spike STORES=org1-store2 PEAK_VUS=10`
  (`k6 inspect -e PROFILE=spike …` shows the shape without traffic)
- Expect:
  - Scenarios: `shoppers` (ramping-vus, 3 → 100 → 3 over 3m50s), `ui-base` (3 Chromium, 0–30 s), `ui-peak`
    (9 Chromium, 40 s–1m40s), `ui-recovery` (3 Chromium, 2m10s–3m50s).
  - The summary has, per window, `browser_web_vital_lcp` and `_ttfb` p75,
    `browser_http_req_duration{…,resource_type:Fetch}` p95 and `journey_errors` rate, with the plain SLO before and
    after the spike and 3× at its peak, next to the storefront layer's lines.
  - The verdict's landing-ui CPU per page view counts the browser page views too.
- Seen:
  - The shape was exact, and every per-window line was in the summary.
  - Failed visits: 13 % before the spike, 100 % at its peak (every navigation timed out at 30 s), 0 % after it.
  - A window where no visit finished shows its trends as 0. Its failed-visit rate is the line that fails.
  - The verdict counted 122 page views, 67 of them from browsers.
  - None of these numbers describes the storefront: the emulated old landing-ui cost 827 ms of Fargate CPU per page.
  - On main's landing-ui at `PEAK_VUS=10`, twice (`docs/baseline.md`):
    - LCP p75 was 1.1 s before the spike, 8.0–9.6 s during it and 1.1 s after it.
    - TTFB p75 during the spike was 6.2–6.6 s.
    - 14–16 % of visits at the peak got no page in 30 s, and none before or after.
    - The verdict passed on the containers: landing-ui at its cap for 45 s, 61–67 ms of Fargate CPU per page.

### 07.4 perf-suite runs the browser spike after the spike [verified 2026-09-14: `SUITE_STEPS=browser-spike SUITE_SPIKE_VUS=2`, `browser-spike-spike-20260914T065128Z`]

- Steps: `SUITE_STEPS=browser-spike make perf-suite`
- Expect: one browser run at `SUITE_SPIKE_VUS` (10), then its verdict rows, then a row per window with LCP p75,
  TTFB p75, API p95 and failed visits beside the threshold expressions of the run.
- Seen: the three rows. The peak row read `17.94 s, -, -, 100%`: its TTFB and API had no finished visit, so they
  printed `-`, not 0.

### 07.5 The spike's shoppers send what a browser sends, or an arrival rate, and every page view says what the cache did [not verified: the load stack ran main's images, which carry no page cache; `k6 inspect` of both models, `make selftest` on the clients]

- Steps:
  - `k6 inspect -e PROFILE=spike -e SPIKE_MODEL=rate -e RATE=60 k6/scripts/browser/storefront-spike.js`: `shoppers` is a
    `ramping-arrival-rate` 60 → 600 → 60 a minute; without `SPIKE_MODEL` it is the `ramping-vus` shape of 07.3.
  - `make browser-storefront-spike PROFILE=spike STORES=org1-store2 PEAK_VUS=10` (`SHOPPER_TRAFFIC=browser`, the
    default): the HTTP shoppers fetch the document of each page and, on three home visits in ten, the suggestions,
    the tree and the site (what the header's search box fetches); `SHOPPER_TRAFFIC=api` sends `browseVisit` as before.
  - `SPIKE_MODEL=x` or `SHOPPER_TRAFFIC=x` fails at once naming the values.
- Expect:
  - The summary carries `storefront_page_cache{name,state}`: on a landing-ui with the page cache, the second view of a
    page within 30 s is `hit`, then `stale`, then `hit` again once the cache refreshed it; a build without the cache
    counts every view as `none`.
  - A Chromium visit is done when the document has parsed and the page's own assertion holds (`main` visible, the
    add-to-cart button); a home page whose YouTube embed takes 20 s to `load` no longer fails the visit.
  - `stack/stack.sh sizes` prints a `pool` column: catalog 8, every other JVM the flavour's (dev 3), and
    `LOAD_POOL_SIZE=5` puts 5 on all of them; `docker inspect` of a running catalog shows
    `SPRING_DATASOURCE_HIKARI_MAXIMUM_POOL_SIZE=8`.
- Seen: `k6 inspect` of both models as expected; `stack/stack.sh sizes` as expected; the stack was not restarted
  (a peer session shares it) so the container's env and the cache states are not verified.
