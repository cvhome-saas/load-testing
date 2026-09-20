# Reading a load test

How a k6 run from this repo shows up here, and how to turn it into findings.

## Before the run

- Start the stack: `make stack-up` (the platform's built images plus monitoring, `stack/docker-compose.yml`; telemetry is on by default).
- From `load-testing`: `make preflight` (is everything answering, is Prometheus ready) then the script:
  `make storefront-browse PROFILE=load PEAK_VUS=50`, `make shopper-guest-checkout PROFILE=load RATE=60 DURATION=10m`,
  `make mixed-production-mix PROFILE=load`, `make storefront-breakpoint` (ramps until an SLO breaks and aborts),
  `make storefront-page-breakpoint STORES=org1-store2` (landing-ui's knee), `make platform-sign-in-burst PROFILE=load`.
- `bin/k6run` tags every sample with a `testid` (`<script>-<profile>-<utc>`), streams it to Prometheus, and posts a
  Grafana annotation at start and end so the run is a shaded region on every dashboard.

## During and after

Open **Load test vs app** (`make dash` opens it for the last `TESTID`) and pick the run in the *Test run* variable.
The page is one time axis, k6 on top, the application underneath:

| row | what to read |
| --- | --- |
| *The run* | VUs, requests, failed share, dropped iterations, orders, journey errors. **Dropped iterations > 0 means k6 ran out of VUs** — the load generator, not the app, was the limit; raise `PEAK_VUS`/pre-allocated VUs and rerun before drawing conclusions. |
| *Load and latency, k6 side* | The load shape and the user-visible latency per endpoint name. Compare each name against its threshold in `k6/config/thresholds.js`. The *failures by endpoint and status* panel says what failed: 429 the limiter, 402 the billing guard, 5xx the platform, 409 contention. |
| *What the application did* | Server-side rate, p95 and 5xx per service, and the service-to-service failure share. If k6 p95 is high but app p95 is low, the time is in spg / landing-ui / the network (Edge dashboard). |
| *What ran out* | Every ceiling as a share on one axis — request threads, database pool, CPU, GC — plus pool waiting, SQL cost and heap. **The first line to reach 0.8 is the bottleneck of this run.** On the load stack, every container against its AWS-sized cap (cAdvisor): *Container CPU against its cap*, *CPU throttling*, *Memory against the limit*, *Containers in this run* (peaks, OOM kills, restarts), and *landing-ui event loop and heap*. |

**The verdict.** `bin/k6run` ends every run but a smoke with `scripts/verdict.mjs` (`make verdict TESTID=…` runs it
again later): per container, the CPU cap, peak CPU against it, how long it stayed at 90 % or more (and the longest
stretch), the share of CPU periods throttled, the memory limit and peak memory against it, OOM kills and restarts; then
landing-ui's CPU per page view (and uaa's per sign-in) in ms of a Fargate vCPU, the number dev's CloudWatch arithmetic
gives. It fails the run on the budgets in `k6/config/budgets.js`: 90 % of a cap for more than a minute in one stretch,
memory above 85 % of the limit, any OOM kill or restart, landing-ui above its CPU per page; a soak also fails when a
working set keeps growing after warm-up. The result is also in `results/<testid>.verdict.json`. Against a deployed
target there is no container to read here; `make aws-report` reads ECS instead.

**What a page ships.** `make page-budget` (`TARGET=aws make page-budget` for dev) renders every theme through
`?theme=<id>` on the store's home, a category, a product and a search, and reports per page: the HTML (and its gzip
size), the RSC payload inside it and that of a client-side navigation, the stylesheets and scripts (count and bytes),
every one of them that carries another theme, and inline CSS that appears twice. A stylesheet carries theme X through
its `[data-theme=X]` rules; a script through the `themes/X/` client modules it defines, read from the build's
client-reference manifests (copied out of the running landing-ui container, or `PAGE_BUDGET_BUILD=<.next dir>`;
without them scripts are counted, not attributed). It fails on `PAGE` in `k6/config/budgets.js`: any file of another
theme, any inline CSS twice, and the byte and file budgets. Both of this weekend's findings — every theme's CSS and JS
on every page, all CSS inlined twice — fail it.

**The whole picture.** `make perf-suite` runs, on the capped stack (it starts it: `make stack-up`), smoke → load
(storefront-browse, `SUITE_LOAD_VUS` 30 shoppers for `SUITE_LOAD_DURATION` 5 min) → spike (`SUITE_SPIKE_VUS` 10, ×10 at
the top, with the recovery probe) → the browser spike (the same spike, Chromium shoppers before, in and after it) → page
breakpoint (`PAGE_MAX_RPS` 20 over `RAMP` 10 min) → sign-in burst
(`SUITE_SIGNIN_DURATION` 3 min) → soak (`SUITE_SOAK` 10 min) → the page budget, and ends with one table: every check —
k6's thresholds, the container at its cap, memory, OOM kills and restarts, CPU per page view and per sign-in, the
recovery p95, the knee, the per-hop sign-in p95s, memory growth, pages over budget — with its number, its budget and
pass or fail. `TARGET=aws make perf-suite` is the same without the stack step, with `aws-report` after every run.
`SUITE_STEPS=load,page-budget` runs a subset. About 40 minutes end to end.

**The knee.** On Bottlenecks → *Traffic vs p95*, the request rate flattens while p95 climbs: that is the capacity of
the system as configured. The saturation strip at that moment names the resource.

## What a finding looks like

Write it in `load-testing/docs/baseline.md`, one row per script and profile:

| script / profile                     | testid            | k6 p95 (worst name)   | app p95        | 5xx | first resource at 0.8      | note                                                                                |
| ------------------------------------ | ----------------- | --------------------- | -------------- | --- | -------------------------- | ----------------------------------------------------------------------------------- |
| storefront-browse / load PEAK_VUS=50 | browse-load-2026… | catalog:search 0.62 s | catalog 0.41 s | 0   | catalog pool 0.8 at 40 VUs | search p95 over its 0.5 s threshold; `SELECT catalog.product_description` p95 0.3 s |

Then the drill: Service RED (route), Database & SQL (statement, statements per request), Service-to-Service (edge),
JVM & Runtime (GC/heap during a soak). The fix goes in the application; the number goes back into
`thresholds.js` once it is met.

## Reading the profiles

- **smoke** proves contracts, not latency: every journey once. Use it to check the dashboards have data.
- **load** is the baseline: the numbers to record.
- **load** holds its peak for `DURATION` (5 min): long enough for a deployed autoscaler, which needs 3–6 min to add a task, to act.
- **stress / spike** loosen the SLO multipliers (2×/3×): they answer "does it degrade gracefully" — watch for 5xx and pool timeouts, not p95. A spike of storefront-browse or production-mix also runs a **recovery probe**: one home page every 3 s from the start, and a `recovery` scenario from 20 s after the spike ends, held to the plain page SLO (`http_req_duration{scenario:recovery}`). A system that never recovers fails there.
- **the spike in a browser**: `browser-storefront-spike` is storefront-browse's spike, with Chromium shoppers measured through it in three windows. `ui-base` is the 30 s before it (`BROWSER_VUS`), `ui-peak` the minute at 10× (`BROWSER_SPIKE_VUS`, 3 × `BROWSER_VUS` by default), and `ui-recovery` runs from 20 s after it to the end. Each visit is one page of the page mix in a fresh context, a first visit; on the home page the shopper types into the search box, so catalog's suggest is called from the browser. Read it by window and page: `browser_web_vital_lcp{scenario:ui-peak}`, `browser_web_vital_ttfb{journey:visit-product}`, and `browser_http_req_duration{scenario:ui-peak,resource_type:Fetch}` for the storefront's API calls from the browser. Before and after the spike, the plain browser SLO holds (LCP p75 4 s, TTFB p75 1.5 s, API p95 800 ms, failed visits under 2 %); during it the spike's 3×, and failed visits under 5 %.
- **soak** holds for `SOAK_DURATION` (30 min): read JVM & Runtime *Heap after GC* (a rising floor is a leak), *Cache size*, gateway sessions, file descriptors. The verdict adds each container's working-set growth after a 5-minute warm-up and fails above 10 % of its limit per hour.
- **breakpoint** ramps until a threshold breaks and aborts: the annotation end is the knee; the saturation strip at that moment is the bottleneck. `storefront-page-breakpoint` is the storefront's: it ramps full page views (landing-ui renders each) to `PAGE_MAX_RPS` (20/s) and aborts when a page misses its 3 s SLO, where `storefront-breakpoint` ramps two catalog APIs and never a page.
- **sign-ins**: `platform-sign-in-burst` paces seller sign-ins at dev's pace, 9 a minute under its 10/min limiter (`SIGNIN_RATE`; locally the limiter allows 1000/min and never binds, and a quarter-vCPU uaa is the limit) and names each hop (`seller:login-submit`, the password check; `-authorize`; `-callback`); the verdict prints uaa's CPU per sign-in.

## Correlating names

k6 names its requests `service:endpoint`; the application sees route templates. The main pairs:

| k6 `name` | service | `uri` |
| --- | --- | --- |
| `catalog:product` | catalog | `/api/v2/products/{slug}` |
| `catalog:search` | catalog | `/api/v2/products/search` |
| `catalog:products-by-category` | catalog | `/api/v2/products` |
| `inventory:availability` | inventory | `/api/v1/availability` |
| `content:layout` | content | `/api/v1/storefront/layout/{code}` |
| `checkout:cart-create` / `cart-update` | checkout | `/api/v1/cart`, `/api/v1/cart/{code}` |
| `checkout:checkout` | checkout | `/api/v1/cart/{code}/checkout` |
| `page:home` / `page:product` | landing-ui | span `GET /[locale]`, `GET /[locale]/product/[slug]` |
| `spg:domain-lookup` | merchant | `/api/v1/router/public/lookup-by-domain` |

(Exact templates: Service RED → *Requests / s by route* while the run is going.)

## The load stack: images, one container each, at their AWS sizes

Numbers from `lcl start` (in cvhome) are development numbers: every service is `gradle bootRun` on the host, with a warm build
daemon behind it, no memory limit, and the storefront on `next dev`. For numbers that mean something about a
deployment, run the platform the way it is deployed — as the images `bootBuildImage` produces, one container per
service, each held to the CPU and memory its Fargate task gets:

```bash
make stack-sizes                            # what every container will get: LOAD_FLAVOUR (dev), LOAD_CPU_FACTOR (0.45)
make stack-up                               # stack/docker-compose.yml: prebuilt images (./gradlew bootBuildImage in cvhome), waits for every /actuator/health
make stack-limits                           # what docker applied: CPU cap and memory limit per container
make smoke                                  # TARGET=local: same ports, hostnames and seeded stores
make stack-stats                            # memory and CPU per container
make stack-down                             # make stack-down-hard drops the volumes: a fresh database next time
```

What it is: the infra and the monitoring are the same containers lcl runs; the fifteen platform containers are added,
each with `deploy.resources.limits` set from `stack/fargate-sizes.json`, a copy of cvhome-platform's `flavours.yaml`
(what `small`, `medium`, `gateway`, `ui` and `ssr` are per environment) and `services.yaml` (which size each service
takes). `LOAD_FLAVOUR` picks the environment: `dev` by default, so an ordinary `make stack-up` already hits dev's walls
(landing-ui 0.5 vCPU, catalog 0.5, uaa 0.25, every JVM 1 GiB; here 0.225, 0.225 and 0.1125 cores); `staging`, `prod` and `ephemeral` are the other
shapes, and `off` is the stack as it was before the caps (no CPU cap, `LOAD_MEM` each). `make sizes-sync` refreshes the
copy from `../cvhome-platform`, and `npm test` fails when it is stale.

- **CPU.** A cap is a CFS quota, the mechanism Fargate uses for a task's CPU. The JVM reads it at start: below one
  core it sees one processor and picks the serial collector and small pools, as it does on a 0.25 or 0.5 vCPU task.
- **`LOAD_CPU_FACTOR`** (0.45) scales every CPU cap, because a Fargate vCPU does less work than a laptop core. It was
  measured under dev's own load shape — storefront-browse, 30 shoppers, org1-store2 — with the same landing-ui build
  (cvhome main after #356) on both sides. Dev on 2026-09-13 (run `browse-load-20260913T214244Z`): landing-ui at 90–96 %
  of its 0.5 vCPU, 88–95 ms of CPU per page (CloudWatch one-minute maxima × 0.5 vCPU ÷ 1,610 page views). Here, the
  same shape: 41.6 ms per page at a 0.325 cap and 42.1 ms at 0.225 (cAdvisor CPU seconds ÷ k6 page views). 42 / 93 =
  0.45: a Fargate vCPU does about 0.45 of the work of an Apple-silicon performance core on this workload. At 0.45 the
  local run (`calib-0.45-browse-load-20260914T010001Z`) behaves like dev's: landing-ui at 90 %+ of its 0.225 cores for
  4m15s without a break, 94 ms of Fargate CPU per page, pages at a p95 of 4.0–5.2 s (dev 3.3–4.2 s, over a slower
  network). At 0.65 the local task had half again dev's capacity. A sequential render harness (60.7 ms a render,
  cvhome#356) had suggested 0.64: one render at a time costs more than renders under load. Another machine may differ:
  measure it the same way (`make storefront-browse PROFILE=load PEAK_VUS=30 DURATION=3m STORES=org1-store2`, the
  verdict's landing-ui CPU per page, against dev's) and set the knob.
- **Memory.** The limit is the task's memory, so the JVM images size their heap from it (the buildpack memory
  calculator) and a service that leaks or over-allocates is killed the way it would be on Fargate. `LOAD_MEM` still
  sets one limit for every platform and infra container, over the flavour.
- **The database is approximate.** postgres gets its RDS instance class's vCPUs (× the factor) and memory
  (`db.t4g.micro`: 2 vCPU, 1 GiB on dev), with PostgreSQL's default settings, and each JVM's Hikari pool is the
  flavour's `db_pool_size` (3 on dev) unless `LOAD_POOL_SIZE` says otherwise. minio has no CPU cap (S3 is not a
  bottleneck on AWS), and the monitoring containers have no cap at all, so observing never becomes the bottleneck.
- **Start-up is slower.** A JVM on a sixth of a core takes minutes to start, as it does on Fargate; `LOAD_WAIT`
  (900 s) is how long `make stack-up` waits for every `/actuator/health`.
- **Logging is a Fargate task's.** The JVMs run the `lcl` profile, for its service discovery, but log at
  `fargate-config.yml`'s levels: `com.asrevo` at INFO, Spring web and security at WARN. The `lcl` profile's DEBUG wrote
  285 lines a request in checkout, 140 in tenancy and 128 in inventory, a stack trace from the locale interceptor on
  most of them, and cost catalog a fifth of its cap in a 3× spike (`docs/baseline.md`, *Heavy spikes*).
  `LOAD_LOG_LEVEL=DEBUG` brings it back for debugging; its numbers are not load numbers.

Inside the network the platform's hostnames (`gateway.com`, `uaa.gateway.com`, `catalog.gateway.com`,
`spg-507f1f77.gateway.com`, the demo store hosts) are container aliases, so spg, the JVMs and the storefront reach
each other by the names the config already uses; on the host the same names still point at 127.0.0.1 through
`/etc/hosts`, and every port is the lcl default, so `load-testing` needs no new target.

Knobs: `LOAD_FLAVOUR` (default `dev`), `LOAD_CPU_FACTOR` (default `0.45`), `LOAD_MEM` (unset: the flavour's sizes),
`LOAD_POOL_SIZE` (Hikari maximum per service, default the flavour's `db_pool_size`, 10 with `off`), `LOAD_TAG` /
`LOAD_REGISTRY` (which images), `JAVA_TOOL_OPTIONS`, `OTEL_SDK_DISABLED` (default `false`: everything exports to the
collector), `LOAD_WAIT` (default 900 s), `LOAD_CDN` (default `true`: the storefront's static files come from MinIO),
`LOAD_LOG_LEVEL` (unset: Fargate's log levels; `DEBUG`: the `lcl` profile's).

The storefront's static files come from a CDN, as on dev. landing-ui publishes its build's `/_next/static` to MinIO
at boot (`minio-init` makes the public-read bucket), and a page points a browser at `http://localhost:9000/…`, as
dev's pages point at CloudFront. A first visit's 14–16 scripts and stylesheets therefore never touch landing-ui's CPU
cap. `make stack-up` prints which mode landing-ui came up in; `LOAD_CDN=false` has it serve them itself.

What still differs from a deployment:

- One task per service, with no autoscaling and no load balancer.
- The laptop's cores are not Fargate's, so the factor is a calibration, not an identity.
- PostgreSQL runs with default settings rather than RDS's parameter group.
- There is no TLS termination.
- MinIO serves the static files uncompressed over HTTP/1.1, where CloudFront uses brotli over HTTP/2.

Record `make stack-stats` alongside the run so a container at its cap is visible.
