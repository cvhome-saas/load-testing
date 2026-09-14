# Baseline

The first measured numbers for the local stack (one JVM per service on one machine, `next dev` storefront, one
PostgreSQL, Hikari 5/1), read from the **Load test vs app** dashboard (`../cvhome/extra/monitoring/docs/load-testing.md`
explains every column). Re-run after a change that touches a hot path and update the row; tighten the matching
threshold in `k6/config/thresholds.js` once a number is met consistently.

Columns: k6 p95 is the worst endpoint `name` of the run against its threshold; app p95 is the server-side
`cvhome:span_server:p95_5m` of the busiest service; _first at 0.8_ is the first saturation ratio on the
_What ran out_ row to reach 80 % (request threads, db pool, cpu, gc) and at what load.

| script / profile                                   | testid                                   | k6 p95 (worst name)                                                                             | app p95                                       | 5xx | first at 0.8                                                          | finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------- | --- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| smoke                                              | `smoke-smoke-20260906T101620Z`           | —                                                                                               | —                                             | 0   | —                                                                     | 308 requests, 0 failed: contracts hold; every dashboard has data afterwards                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| storefront-browse / load, PEAK_VUS=30 DURATION=3m  | `browse-load-20260906T102015Z`           | `page:home` 4.99 s (threshold 3 s; `page:product` 4.72 s, `page:category` 4.66 s also breached) | landing-ui 4.58 s, spg 2.63 s, catalog 0.05 s | 0   | none — pool 40 % (catalog), threads 1 %, CPU 24 %                     | the time is the `next dev` render, not the platform: the APIs behind the pages answer in 14–27 ms (`catalog:search` p95 27 ms). **catalog runs 21 SQL statements per request** (`cvhome:sql_per_request:ratio5m`) — an N+1 on the category/product reads to fix before it matters. 9,531 requests, 0.02 % failed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| shopper-guest-checkout / load, RATE=40 DURATION=3m | `guest-checkout-load-20260906T102651Z`   | `checkout:checkout` 74 ms (threshold 2 s)                                                       | checkout 0.09 s                               | 0   | none — pool 0 %, threads 0 %, CPU 15 %                                | 947 requests, 0.1 % failed, 121 orders; purchase journey p95 264 ms. checkout runs 11 statements per request. `landing-ui → spg` edge shows 4 % failed calls (storefront page fetches, not the API).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| mixed-production-mix / load, DURATION=3m           | `production-mix-load-20260906T103013Z`   | `page:*` ≈ 4.4 s (dev server)                                                                   | landing-ui 4.37 s, gateway 0.33 s             | 0   | none — CPU 17 %, pool 0 %                                             | 3,873 requests, 0.9 % failed, 31 orders, 39 VUs peak, app peak 97 req/s. **`http_req_failed{layer:admin}` breached (2 %)**: 403s on `tenancy:store-unique`, `tenancy:store`, `tenancy:store-info`, `billing:entitlement`, `merchant:store-private` — the `store-reads` journey took whichever pooled session the VU pointed at, and a store admin or moderator is refused on the org-level reads by design (visible on _Auth_ → _Rejections by reason_ as `AccessDeniedException` from the advice). Fixed since: `sessionWithRole(..., ['ORG_ADMIN'])` in `admin/store-reads.js`, `mixed/production-mix.js` and `smoke.js`; `admin/store-reads` at the smoke profile then ran 12 admin requests with 0 failed, plus 409s on `catalog … /category/{categoryId}` from concurrent catalogue edits (expected). |
| storefront-breakpoint, MAX_RPS=150 RAMP=4m         | `breakpoint-breakpoint-20260906T103424Z` | `catalog:product` 9 ms, `inventory:availability` 4 ms — no threshold broke, the ramp completed  | catalog 0.05 s                                | 0   | none — pool 20 % (catalog, inventory), threads 0.5 %, system CPU 29 % | **no knee within the ramp**: 54,238 requests, 0 failed, 0 dropped, 300 k6 req/s = 552 req/s on the application (each product view fans out). The API tier has > 5× the headroom of this ramp; run again with `MAX_RPS=600 RAMP=6m` and more pre-allocated VUs to find it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## How a row is filled

1. `make <script> PROFILE=load` (the `testid` is printed on the first line and is the run's annotation in Grafana).
2. `make dash TESTID=<testid>` → read _The run_ stats, _k6 p95 by endpoint_ (worst name), _App p95 by service_,
   _App 5xx / s_, and _Saturation_ (the first line to cross 0.8 and the VU/rate at that moment).
3. One sentence of finding: which route, which statement or edge, from Service RED / Database & SQL /
   Service-to-Service at the run's time range.

### Re-run after the cvhome performance fixes (2026-09-06, built storefront: `npm run build` + `node start.mjs` on 8110 in place of `next dev`)

The fixes and their causes: `cvhome/extra/monitoring/docs/performance-improvements.md`.

| script / profile                                                      | testid                                   | k6 p95 (worst name)                                         | app p95                                                                 | 5xx | first at 0.8                                            | finding                                                                                                                                                                                                                  |
| --------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- | --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| storefront-browse / load, 30 VUs, DURATION=3m                         | `browse-load-20260906T124154Z`           | `page:home` 91 ms (was 4.99 s on the dev server)            | landing-ui render 91–98 ms; catalog, content, inventory, merchant 48 ms | 0   | none — 86 app req/s                                     | 14,055 requests, 0 failed. catalog 5.7 SQL/request (was 21.3), `landing-ui → spg` failed 0 (was 4.2 %)                                                                                                                   |
| shopper-guest-checkout / load, DURATION=3m                            | `guest-checkout-load-20260906T124807Z`   | `checkout:checkout` 86 ms                                   | checkout under 100 ms                                                   | 0   | none                                                    | 90 orders, 0 failed; checkout 5.7 SQL/request (was 11.2): the sequencer round-trips per insert are gone                                                                                                                  |
| mixed-production-mix / load, DURATION=3m                              | `production-mix-load-20260906T125109Z`   | `page:*` under 0.1 s (was ~4.4 s)                           | —                                                                       | 0   | none — 46 app req/s                                     | 3,918 requests, **0 failed on every layer** (admin was 2 %: the store-reads journey now takes an org-admin session), 31 orders; the 409s on `catalog … /category/{categoryId}` from concurrent edits remain, as expected |
| storefront-breakpoint / breakpoint, MAX_RPS=600, RAMP=6m              | `breakpoint-breakpoint-20260906T125416Z` | `catalog:product` 9.4 ms at 1,200 k6 req/s                  | catalog inside the 50 ms bucket throughout                              | 0   | none — CPU 71 % at peak, catalog pool 40 %, threads 1 % | 288,358 requests, 0 failed, 0 dropped: **no knee up to 1,540 app req/s**; CPU is the first resource to give out on this one-machine stack. Next: 2,000+ req/s with more pre-allocated VUs, and the write scripts         |
| smoke, fresh stack (`lcl stop --hard` + start)                        | `smoke-smoke-20260906T133127Z`           | —                                                           | —                                                                       | 0   | —                                                       | 308 requests, 0 failed; fixtures re-provisioned on the empty database                                                                                                                                                    |
| storefront-browse / load, 30 VUs, DURATION=3m, fresh stack            | `browse-load-20260906T133147Z`           | `page:home` 91 ms                                           | landing-ui render under 0.1 s                                           | 0   | none                                                    | 14,043 requests, 0 failed — the same numbers as the first re-run                                                                                                                                                         |
| shopper-guest-checkout / load, DURATION=3m, fresh stack               | `guest-checkout-load-20260906T133755Z`   | `checkout:checkout` 53 ms                                   | —                                                                       | 0   | none                                                    | 91 orders, 0 failed                                                                                                                                                                                                      |
| mixed-production-mix / load, DURATION=3m, fresh stack                 | `production-mix-load-20260906T134058Z`   | `page:*` under 0.1 s                                        | —                                                                       | 0   | none                                                    | 3,939 requests, 0 failed on every layer, 31 orders                                                                                                                                                                       |
| storefront-breakpoint / breakpoint, MAX_RPS=600, RAMP=6m, fresh stack | `breakpoint-breakpoint-20260906T134403Z` | `catalog:product` 10.7 ms (max 11.8 s: one stalled request) | —                                                                       | 0   | CPU, as before                                          | 276,221 requests, 0 failed, **57 dropped iterations**: the generator (50 VUs) ran out first at ~1,200 k6 req/s; raise `preAllocatedVUs` before the next ramp. Still no knee                                              |

### The load stack: images, one container each, 1 GB (2026-09-06)

Run against `cvhome/docker-compose-load.yml` — every service as its built image rather than `gradle bootRun`. What
the storefront rows mean, and the emulation caveat, are in `cvhome/extra/monitoring/docs/performance-improvements.md`
("What running the images showed").

| script / profile                                        | testid                                   | k6 p95 (worst name)       | app p95                               | 5xx | first at 0.8                                      | finding                                                                                                                                  |
| ------------------------------------------------------- | ---------------------------------------- | ------------------------- | ------------------------------------- | --- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| smoke                                                   | `smoke-smoke-20260906T190111Z`           | —                         | —                                     | 0   | —                                                 | 308 requests, 0 failed, 2 orders: the images serve every journey                                                                         |
| storefront-browse / load, 30 VUs                        | `browse-load-20260906T190309Z`           | `page:home` 2.63 s        | catalog 7.4 ms, spg per-route 5–45 ms | 0   | none                                              | 9,288 requests, 0 failed. The storefront image is amd64 and was emulated on this arm64 host; the same build on an arm64 base gave 157 ms |
| shopper-guest-checkout / load                           | `guest-checkout-load-20260906T190928Z`   | `checkout:checkout` 48 ms | —                                     | 0   | none                                              | 90 orders, 0 failed                                                                                                                      |
| mixed-production-mix / load                             | `production-mix-load-20260906T191234Z`   | —                         | —                                     | 0   | none                                              | 3,869 requests, 0 failed on every layer, 31 orders                                                                                       |
| storefront-breakpoint / breakpoint, MAX_RPS=600         | `breakpoint-breakpoint-20260906T191542Z` | `catalog:product` 6.0 ms  | —                                     | 0   | none — pool 20 %, threads 1 %, heap after GC 19 % | 288,358 requests, 0 failed, 0 dropped, **1,530 app req/s**: the API tier is unaffected by the 1 GB limit                                 |
| storefront-browse / load, arm64 storefront (experiment) | `browse-load-20260906T195057Z`           | `page:home` 157 ms        | —                                     | 0   | none                                              | 13,935 requests, 0 failed. Same build, same 1 GB limit, native architecture: 17× faster than the emulated image                          |

### JVM vs native images on the load stack (2026-09-11)

cvhome-saas/cvhome#349 can build every Spring service as a GraalVM native executable (`./gradlew bootBuildImage
-Pnative` in cvhome, same image names). Both sets came from that branch and ran the same scripts, each on a fresh
stack (`make stack-down-hard`): the JVM images at `LOAD_MEM=1g`, the native ones at `LOAD_MEM=512m` — the size a native
Fargate task would get. `LOAD_MEM` caps every container, postgres and the monitoring included. The storefront and
console images are amd64 and emulated on this arm64 host in both runs, so `page:*` is slow in both and left out of the
worst-name column.

| script / profile                                | image          | testid                                   | k6 p95 (worst API name)      | 5xx | first at 0.8                     | finding                                                                                                           |
| ----------------------------------------------- | -------------- | ---------------------------------------- | ---------------------------- | --- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| smoke                                           | JVM, 1 GB      | `smoke-smoke-20260911T104007Z`           | `tenancy:signup` 866 ms      | 0   | —                                | 304 requests, 0 failed                                                                                            |
| smoke                                           | native, 512 MB | `smoke-smoke-20260911T125312Z`           | `cua:login` 563 ms           | 0   | —                                | 302 requests, 0 failed — the same one `spg:domain-lookup` check as the JVM (the new fixture host, not yet cached) |
| storefront-browse / load, 30 VUs, 3m            | JVM, 1 GB      | `browse-load-20260911T104049Z`           | `catalog:search` 25 ms       | 0   | none — catalog pool 20 %         | 9,965 requests, 0 failed; `catalog:listing` 10.0 ms, `catalog:product` 11.0 ms                                    |
| storefront-browse / load, 30 VUs, 3m            | native, 512 MB | `browse-load-20260911T125349Z`           | `catalog:search` 25 ms       | 0   | none                             | 9,726 requests, 0 failed; `catalog:listing` 11.1 ms, `catalog:product` 11.5 ms — the JVM's numbers                |
| shopper-guest-checkout / load, 3m               | JVM, 1 GB      | `guest-checkout-load-20260911T104715Z`   | `seller:login-submit` 270 ms | 0   | none                             | 730 requests, 0 failed; `checkout:checkout` 61 ms                                                                 |
| shopper-guest-checkout / load, 3m               | native, 512 MB | `guest-checkout-load-20260911T130017Z`   | `seller:login-submit` 255 ms | 0   | none                             | 730 requests, 0 failed; `checkout:checkout` 30 ms                                                                 |
| mixed-production-mix / load, 3m                 | JVM, 1 GB      | `production-mix-load-20260911T105038Z`   | `seller:login-submit` 282 ms | 0   | none                             | 3,911 requests, 0 failed on every layer; `catalog:search` 24 ms                                                   |
| mixed-production-mix / load, 3m                 | native, 512 MB | `production-mix-load-20260911T130339Z`   | `seller:login-submit` 262 ms | 0   | none                             | 3,840 requests, 0 failed; **`catalog:search` 89 ms** — 24 ms on the JVM, and equal to it in browse: open          |
| storefront-breakpoint / breakpoint, MAX_RPS=600 | JVM, 1 GB      | `breakpoint-breakpoint-20260911T105404Z` | `catalog:product` 18 ms      | 0   | none — catalog pool 30 %         | 146,309 requests, 0 failed, 24 dropped (k6 out of VUs at ~490 iterations/s), 885 app req/s peak                   |
| storefront-breakpoint / breakpoint, MAX_RPS=600 | native, 512 MB | `breakpoint-breakpoint-20260911T130706Z` | `catalog:product` 19 ms      | 0   | catalog pool 0.8 at ~1,190 req/s | 168,858 requests, 0 failed, 12 dropped: further into the ramp than the JVM; 1,187 app req/s peak                  |

Per service, all twelve starting at once: 4.4–10.2 s on the JVM, 0.3–2.2 s native. Memory at peak, from
`make stack-stats` every 10 s: 259–496 MiB per JVM service (4,475 MiB for the twelve) against 118–345 MiB native
(2,284 MiB); no restart and no OOM kill in either run. Natively the JVM gauges are absent (`jvm_heap_after_gc`,
`jvm_gc_pause`) and `jvm_cpu` is not trustworthy (merchant read 1.0 while nearly idle): use `make stack-stats` for a
native service's CPU.

Two native runs before these found what a native image needs that the JVM does not, all fixed in #349: records kept
as JSON columns and generic list elements not registered for Jackson (every storefront banner read answered 500),
Spring Data JDBC's generated repositories mapping DTO queries onto the entity, a `ResourceBundle` a native image did not
carry, telemetry frozen off at build time (no service in Prometheus), and a `@Cacheable` store lookup that was never
proxied — merchant served 190 req/s natively against 7.6 on the JVM and catalog's list reads were 3–7× slower until
it was.

### The capped stack: every container at dev's size (2026-09-14)

The load stack at `LOAD_FLAVOUR=dev`, `LOAD_CPU_FACTOR=0.45`: every service held to its dev Fargate task's CPU ×
0.45 and its memory (landing-ui, catalog, content, merchant, spg, store-core-gateway 0.225 cores; the other JVMs and
console-ui 0.1125; postgres 0.9; every JVM 1 GiB). The runs are `make perf-suite`'s steps plus the calibration run,
next to what dev measured on 2026-09-13. Images: the Spring services are the local `:native` set from the old
GraalVM branch (before cvhome#354); landing-ui is cvhome main `113caa92b` (after #356) on an arm64 node:20-alpine
image built for this run only. Dev ran JVM images of the same main.

| run                                                      | dev, 2026-09-13                                                                                                                                                                          | here, capped                                                                                                                                                                                                                                                                                                                                                                       | finding                                                                                                                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| storefront-browse, 30 shoppers, 3-min hold (dev's shape) | `browse-load-20260913T214244Z`: landing-ui at 90–96 % of 0.5 vCPU; pages p95 4.2 / 3.9 / 3.3 s (home, category, product); ~88–95 ms of CPU per page; 1,610 page views in 6m08s, 0 failed | `calib-0.45-browse-load-20260914T010001Z`: landing-ui at 90 %+ of 0.225 cores for 4m15s without a break, throttled 82 %; pages p95 5.2 / 5.0 / 4.0 s; 42.1 ms here = 94 ms of Fargate CPU per page; 1,795 page views in 6m05s, 0 failed                                                                                                                                            | reproduces dev: landing-ui is the wall, at the same CPU per page. The factor comes from this pair                                                                                 |
| the same at `LOAD_CPU_FACTOR=0.65`, 5-min hold           | —                                                                                                                                                                                        | `load-load-20260914T000658Z`: landing-ui at 97 % of 0.325 cores in the hold, 41.6 ms per page, 7.6 page views/s                                                                                                                                                                                                                                                                    | half again dev's capacity (~5 page views/s): 0.65 was too generous                                                                                                                |
| storefront-browse, 30 shoppers, 5-min hold               | —                                                                                                                                                                                        | `load-load-20260914T011020Z`: landing-ui at 90 %+ for 5m45s (longest 2m00s), throttled 86 %; pages p95 8.3 / 8.0 / 6.3 s; 108 ms Fargate per page; memory 51 % of 1 GiB; catalog 46 %                                                                                                                                                                                              | the longer hold deepens the queue; verdict FAIL on landing-ui's CPU                                                                                                               |
| spike, 10 → 100 shoppers                                 | `browse-spike-20260913T222330Z`: a steady home-page probe waited up to 26 s and once timed out at 60 s; landing-ui memory 10 → 59 % of 1 GB                                              | `spike-spike-20260914T011845Z`: pages p95 60 / 30 / 18.5 s, 9 % of home journeys failed; landing-ui at its cap for 1m15s, 166 ms Fargate per page under overload, memory 42 %; recovery probe p95 0.92 s from 20 s after the spike                                                                                                                                                 | recovers once the spike ends; overload costs more CPU per page (budget 130 ms: FAIL)                                                                                              |
| page breakpoint, 1 → 20 page views/s over 10 min         | — (dev's implied capacity: 0.5 vCPU ÷ ~93 ms ≈ 5.4 page views/s per task)                                                                                                                | `page-breakpoint-breakpoint-20260914T012303Z`: aborted after 1m58s, page:home p95 3.2 s at ≈ 3.8 page views/s offered                                                                                                                                                                                                                                                              | landing-ui's knee at dev's size, home first                                                                                                                                       |
| seller sign-in                                           | `gateway-login-load-20260913T215056Z`, 8/min: sign-in p95 3.15 s, the password check ~1.5 s of server time, uaa at 44 % of 0.25 vCPU (≈ 0.8 s of Fargate CPU per sign-in)                | `sign-in-burst-load-20260914T012522Z`, 9/min: uaa at 90 %+ of 0.1125 cores for 2m45s; sign-in p95 98 s; 3.9 s of Fargate CPU per sign-in; `seller:login-callback` p95 57 s                                                                                                                                                                                                         | an artefact of the local uaa: the old native image still bcrypts the client secret at the callback (#354 removed that) and runs without a JIT. Re-measure with current JVM images |
| soak, 20 shoppers, 10 min                                | —                                                                                                                                                                                        | `soak-soak-20260914T012913Z`: pages p95 4.6 / 3.5 / 3.2 s; landing-ui 91 % peak; no OOM kill, no restart; catalog's working set +32 %/h over the 5 min after warm-up                                                                                                                                                                                                               | the growth is reported, not judged: it counts from a 30-minute soak                                                                                                               |
| page budget, 12 themes × 4 pages                         | dev after #356: 2 CSS + 16 JS files a page                                                                                                                                               | this landing-ui (main after #356): 48 of 48 pages in budget, 0 files of another theme, 2 stylesheets (85–116 KiB), 14–16 scripts (~1.1 MiB), HTML 93–269 KiB. The old `store-pod/landing-ui:native` (before #353/#356), fashion, basic and grocery: 12 of 12 over budget — 31 scripts (1.7 MiB), 11 of another theme's, all CSS inlined with 288 KiB of it twice, HTML 700–846 KiB | both weekend findings fail the budget; the current build passes                                                                                                                   |

The first suite run (`*-20260914T00*`) is not a baseline: another experiment sent storefront traffic to this stack's
backend from 00:12 to 00:47 UTC and the machine slept from 00:15 to 00:32. Only its landing-ui CPU per page (its own
container, untouched) was used, as the 0.65 row above.

### The storefront spike in a browser (2026-09-14)

`browser-storefront-spike`, `PEAK_VUS=10` on org1-store2: 3 → 100 HTTP shoppers for the minute at 10×. Chromium
shoppers are measured before, during and after it (3 / 9 / 3), and each visit is a first visit to one page. The stack is
capped at dev's sizes (factor 0.45), with the storefront's static files served from MinIO.

- **landing-ui:** cvhome main `e220976a8`, after #357 (Node 24, one currency formatter, identity encoding to spg). It
  ran as a local-only arm64 image on `node:24-alpine`, deleted after the runs; production's Node 24 base is amd64 only
  and would run emulated here.
- **The Spring services:** the `:native` set of the capped rows above. spg is the amd64 image of 2026-09-11.
- **Runs:** two, `storefront-spike-spike-20260914T071803Z` and `…T072333Z`. Each figure below is the range of the two.

What a shopper's browser saw:

| window | LCP p75 | TTFB p75 | API calls from the browser p95 | visits with no page in 30 s |
| --- | --- | --- | --- | --- |
| before the spike (3 shoppers, 3 browsers) | 1.11–1.14 s | 0.04–0.14 s | 19–25 ms | 0 of 21 |
| the minute at 10× (100 shoppers, 9 browsers) | 8.0–9.6 s (p95 38–45 s) | 6.2–6.6 s | 68–482 ms | 5–6 of 36–37 (14–16 %) |
| from 20 s after it | 1.11–1.12 s | 0.04–0.07 s | 19–21 ms | 0 of 68–70 |

The load and the containers, next to the capped HTTP spike before #357 (`spike-spike-20260914T011845Z`). That run
had the same HTTP shoppers and backend images, no browsers, and landing-ui main `113caa92b` on Node 20:

| | before #357, HTTP spike | main after #357, browser spike |
| --- | --- | --- |
| HTTP pages p95: home / category / product | 60 / 30 / 18.5 s | 27.6–35.9 / 23.0–34.6 / 21.2–24.4 s (medians 5.0–6.5 s) |
| failed | 9 % of home journeys (60 s timeouts) | no request of 4,824–5,304 |
| landing-ui at its cap | 1m15s | 45 s, at 99–100 % |
| landing-ui CPU per page view, Fargate | 166 ms | 61–67 ms |
| landing-ui memory | 42 % of 1 GiB | 26–27 % |
| page views served at the cap | — | 7.3–8.5 a second |
| catalog | — | 74–77 % of its cap; p95 product 485–582 ms, by category 393–507 ms, search 603–678 ms |
| inventory | — | 48–58 % of its cap; availability p95 47–151 ms |

**Finding.** One landing-ui task at dev's size is still the wall under a 10× spike.

- At its cap it serves 7–8.5 page views a second. A shopper arriving mid-spike waits about 6 s for the first byte and
  8–10 s for the page, and one in seven gets nothing within 30 s.
- It recovers within 20 s of the spike's end. Before the spike, a page paints in 1.1 s.
- catalog is second, at about three quarters of its cap, and its p95 stays under 0.7 s.
- #357 cut what a page costs under overload by 60 %, and took the failed requests to none. The queue is what remains.
  A one-minute spike ends before autoscaling can add a task (3–6 min).
- The peak's Web Vitals count only the visits that finished.

### Heavy spikes: 3× and 5× in a browser, the production mix at 20× (2026-09-14)

The same stack at dev's sizes (factor 0.45), pushed well past the wall above.

- **Images:** every image was rebuilt from cvhome main `c0f7ea358`, after #358 (Next 16.3.5, React 19.2.8).
  - The Spring services are JVM images (`./gradlew bootBuildImage`, arm64), and so is what dev runs.
  - landing-ui is that commit's standalone build on `node:24-alpine`, a local-only arm64 image; production's base is
    amd64 only.
  - spg is the amd64 image, emulated.
- **Store:** org1-store2. The browser spikes use 3 / 9 / 3 Chromium shoppers: 15 at the peak ran this Mac out of
  memory.
- **The load generator:** never the limit. The host stayed at least 35 % idle with at least 58 % of its memory free.
- **Two passes.** The first ran the JVMs at the `lcl` profile's DEBUG. The second ran them at Fargate's log levels,
  now the stack's default (`LOAD_LOG_LEVEL`). The table is the second pass. The first is in the finding on logging.

| run, Fargate log levels | shoppers or offered rate | failed | pages p50 / p95 | a browser at the peak | landing-ui at its cap | next container | checkout |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `heavy-x3-storefront-spike-spike-20260914T100732Z` | 8 → 300 for a minute | 2.7 % | home 7.1 / 60 s; product 5.3 / 12.1 s | none of 9 finished a page inside the window | 75 s (longest 45 s), 73 ms of Fargate CPU a page | catalog 79 %, never at its cap | idle |
| `heavy-x5-storefront-spike-spike-20260914T101246Z` | 13 → 500 for a minute | 4.4 % | home 42.4 / 60 s; product 3.9 / 60 s | LCP p75 5.7 s, TTFB p75 4.7 s, 0 of 15 failed | 2m15s in one stretch, 70 ms a page | catalog 91 %, 15 s at its cap | idle |
| `heavy-rate60-production-mix-spike-20260914T101748Z` | the normal day ×2, ×20 for a minute | 7.6 % | every page p95 60 s | — | 2m15s | catalog 100 %, 90 s at its cap; uaa 61 %; inventory 59 % | **94 % of purchases failed (13 orders)** |

What a shopper's browser saw at 5×, window by window:

| window | LCP p75 | TTFB p75 | failed visits |
| --- | --- | --- | --- |
| before the spike (13 shoppers) | 1.62 s | 0.84 s | 0 of 18 |
| the minute at 5× | 5.70 s | 4.66 s | 0 of 15 |
| from 20 s after it | 1.25 s (p95 56 s) | 0.13 s | 3 of 31 |

**Finding: landing-ui is the one wall for storefront traffic.**

- At its cap, a render costs 70–73 ms of a Fargate vCPU. One 0.5 vCPU task serves about 7 page views a second.
- Every page is rendered per request: the build marks every route dynamic, and nothing caches the HTML.
- At 5×, home's median response took 42 s. A third of home journeys failed, and the p95 of every page was the 60 s
  client timeout.
- The queue outlives the spike. landing-ui stayed at its cap 53 s (3×) and 75 s (5×) after the load dropped. With
  catalog idle beside it, it was rendering pages whose clients had already given up. Nothing cancels an abandoned
  request or sheds load, so recovery waits for the backlog.
- In the mix, spg answered 69 pages with a 502.

**Finding: checkout falls over while it is nearly idle.**

- Its pool of 3 ran dry in both mixed spikes: "total=3, active=3, idle=0, waiting=199".
- In the second pass, 2,562 waits timed out after 30 s. That was 562 failed cart creations and 258 failed admin order
  lists, and the run placed 13 orders. The same mix at a normal day's rate places 31 in three minutes.
- checkout's CPU peaked at 32 % of its cap (54 % at DEBUG), and PostgreSQL's at 11 %.
- The cause is in the code (cvhome `c0f7ea358`):
  - `CartServiceImpl.create`, `upsert` and `get` are read-write `@Transactional`. Each holds its connection while it
    calls catalog (`/api/v1/detailed-products`) and inventory (`/api/v1/availability/query`) over HTTP.
  - No RestClient in store-commons or store-pod sets a connect or read timeout.
  - `spring.jpa.open-in-view` is left at its default, true.
- So three slow calls to catalog stop checkout.
- The same collapse appeared once without a spike. After the JVMs restarted, a normal day with 15 shoppers beside it
  failed 81 cart creations. A trace of one of them held its connection for 120 s: 30 s waiting for it, 11 s in
  catalog, then 78 s the trace does not account for. Where those 78 s went is open.

**Finding: catalog spends its CPU in the JVM, and holds its connections past the database.**

Statements per request, counted from traces at a normal day's load (`sql-trace-mix-*`):

| route | statements | server | in SQL |
| --- | --- | --- | --- |
| `/api/v2/products/search` | 9.8 (up to 15) | 89.5 ms | 6.6 ms |
| `/api/v2/products` | 7.6 | 5.1 ms | 1.6 ms |
| `/api/v2/product/name/{friendlyUrl}` | 6.3 | 7.3 ms | 4.6 ms |
| `/api/v1/detailed-products` | 3.0 | 7.1 ms | 3.3 ms |
| `/api/v1/products/groups/{code}` (28 % of requests) | 1.0 | 1.2 ms | 0.2 ms |

At 5×, catalog ran 59,703 statements for 10,378 requests, 5.75 each. 95 % of them finished under 5 ms, and
PostgreSQL never passed 11 % of its CPU. The cost is in catalog itself (cvhome `c0f7ea358`):

- **Search runs facets on every call.** It pages, counts, hydrates, loads three batches, then runs four `GROUP BY`
  facet queries and four label loads. landing-ui's category page calls `search?count=1&facets=true` for the facets
  alone.
- **Criteria plans recompile on every call.** `hibernate.criteria.plan_cache_enabled` is off by default, and the
  listing, search and facets are all Specifications.
- **Fetch joins multiply rows.** `findAllHydrated`, `findByStoreAndId` and `findByStoreAndFriendlyUrl` join
  descriptions × images × brand and type descriptions: about 20 rows a product on seed data.
- **Open-in-view is on by default.** Each connection is held until the response has been serialised; on a throttled
  half vCPU that is time spent waiting for CPU. In the mixed spike, 135 requests waited for one of catalog's 3.
- **`HHH90003004` comes from one storefront query,** `CategoryRepository.findByStore` behind
  `/api/v1/category-hierarchy`. It pages categories with their descriptions fetch-joined.
- **No hot route has a server-side cache.**

**Finding: the database scans what it should look up.**

- `catalog.product_image` has no index on `product_id`. The stack's life so far: 59,142 full scans, 53.2 million rows
  read.
- `inventory.product_price` has only its primary key, so 94 % of its reads were full scans.
- `ddl-auto: update` added a second copy of each unique index on `catalog.product_variant`, beside the ones
  `schema.sql` creates.
- The seeded 200 products hide all of it.

**Finding: N+1 queries elsewhere.**

- checkout's admin orders list: 42 statements a request, customer account and totals once per row.
- Placing an order: 22.
- content's `storefront/site`: 12.
- inventory's bulk update: 21 for 20 SKUs.

**Finding: the connection budget outgrows RDS.**

- Pools multiply by tasks: 11 services × up to 12 tasks × 6 in prod is 792 connections.
- `db.t4g.small` allows about 200.

**Finding: the HTTP shopper journeys send catalog reads a browser does not.**

- `browseHome`, `browseCategory` and `browseProduct` send each page, then the API reads landing-ui makes while it
  renders that page.
- A browser sends only the page. `browser-browse` made 32 page views, 81 catalog calls, and not one trace that started
  in the browser went to catalog (`d1-browser-browse-20260914T102410Z`).
- Page views alone cost the same 2.4 catalog calls a view (`d2-page-views-breakpoint-20260914T102521Z`).
- In the spikes, the journeys' own calls were 45 % of everything catalog served. Real shoppers would load catalog
  about half as much as these runs did. landing-ui's numbers are unaffected: it renders the same page either way.

**Finding: the `lcl` profile's DEBUG logging was a load of its own.**

- Under the mixed spike, checkout wrote 285 log lines a request, tenancy 140 and inventory 128. Most carried a stack
  trace from `RequestCacheAwareLocaleInterceptor`, which catches the exception `AcceptHeaderLocaleResolver.setLocale`
  throws.
- At Fargate's levels:
  - 3×: catalog fell from 99.7 % of its cap (60 s at it) to 79 % (never at it). `catalog:product` p95 fell from 8.6 s
    to 2.3 s.
  - 5×: catalog went from 75 s at its cap to 15 s.
  - The mix: tenancy fell from 69 % to 40 %.
- Checkout's collapse did not change, so that finding stands on its own.
- The DEBUG pass: `heavy-x3-storefront-spike-spike-20260914T092543Z` (a Chromium was killed at 2m36s and k6 aborted,
  after the peak), `heavy-x5-storefront-spike-spike-20260914T093137Z` and
  `heavy-rate60-production-mix-spike-20260914T093713Z`.

What the application needs, by owner, easiest first. The report with the evidence and file references:
<https://claude.ai/code/artifact/6a901437-b6d9-4b55-b186-a360eff4d46b>.

- **cvhome, common-config.yml `spring.jpa`:**
  - `open-in-view: false`;
  - `properties.hibernate.default_batch_fetch_size: 50`;
  - `hibernate.criteria.plan_cache_enabled: true`;
  - `ddl-auto: validate`, because `schema.sql` owns the schema.
- **cvhome, checkout:**
  - take the catalog and inventory snapshot before the cart transaction (`CartServiceImpl` :43, :57, :73, :82);
  - give every RestClient a connect and read timeout;
  - set Hikari's `connection-timeout` to about 3 s;
  - skip `customerOf` when an order is listed without detail.
- **cvhome, catalog:**
  - drop the fetch join from the paged category queries;
  - add a facets-only search path;
  - split the multiplying fetch joins;
  - Caffeine response caches on groups, categories, manufacturers, product by URL, suggest and facets;
  - indexes on `product_image(product_id)`, `category_description(sef_url, language_code)`,
    `category(store_merchant_id, lineage varchar_pattern_ops)`, `product(store_merchant_id, manufacturer_id)`,
    `product(product_type_id)` and `product_group_product(product_id)`.
- **cvhome, inventory:** an index on `product_price(product_avail_id)`.
- **cvhome, landing-ui:**
  - cache anonymous renders of home, category, product and search pages per store;
  - shed load or cancel a render when its client has gone;
  - time out backend calls at 2–3 s.
- **cvhome-platform:**
  - `ssr` is 0.5 vCPU in every flavour, prod included;
  - uaa's 0.25 vCPU fills with four sign-ins at once;
  - capacity for a spike has to exist before it starts, since target tracking reacts in minutes;
  - pooled connections at max scale exceed RDS's limit: RDS Proxy, or pools and max tasks sized to the budget;
  - raise `rds.db_pool_size` only after the transaction and open-in-view fixes.
- **load-testing:** the browse journeys should send only what a browser sends. That changes every storefront baseline,
  so it is its own change.
