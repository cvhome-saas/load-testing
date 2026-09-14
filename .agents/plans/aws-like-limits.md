# The load stack runs every service at its AWS size, and the suite finds what runs out

One PR, `feat/perf-detection`, one commit per phase, easiest first. It lives in load-testing. The one fact it copies
from another repo, the Fargate sizes, is handed to the orchestrator's contract check (see Deviations).

## Why (2026-09-13 / 14)

Every performance problem found on dev this weekend was invisible in local load tests. The reason is a limit the
local stack does not have:

| Found on dev | Why local runs missed it |
| --- | --- |
| landing-ui pinned at 90–100 % of its 0.25, then 0.5, vCPU; pages at 20 s, then 4 s, at 30 shoppers | `stack/docker-compose.yml` caps memory (`LOAD_MEM`) but **not CPU**. Locally landing-ui used 1.5–2.4 of the laptop's cores |
| catalog at 81–100 % of 0.5 vCPU once the storefront got faster | the same: no CPU cap, and the breakpoint script ramps two catalog APIs, never a page |
| Sign-in ~2 s: a bcrypt-12 password check on a 0.25-vCPU uaa | no CPU cap, and the local limiter (1000/min) is nothing like dev's (10/min) |
| landing-ui memory 10 → 59 % of 1 GB in a spike, ~1.7 MB per waiting request | the local spike ran at a uniform 512 MB, not the task's real size; nothing reads memory against the limit during a run |
| 11 other themes' CSS and JS on every page; all CSS inlined twice | no check looks at what a page ships |
| Autoscaling needs 3–6 min to add a task; a 3-minute spike never scales | runs are 3 minutes; nothing reports task counts |

**The proof it matters:** when we did cap CPU locally (the 0.25-CPU render harness), a landing-ui render cost 204 ms,
and dev measured 206 ms per page.

## Decisions

- **Sizes come from cvhome-platform, not from memory.** `scripts/sync-fargate-sizes.mjs` reads the sibling
  checkout's `flavours.yaml` and `services.yaml` and writes `stack/fargate-sizes.json`: for each flavour, each
  service's `cpu`/`memory`. `--check` fails when the copy is stale (it runs in `npm test` when `../cvhome-platform`
  exists), and the orchestrator's contract check keeps the two in step.
- **One knob picks the shape.** `LOAD_FLAVOUR=dev` is the default, so an ordinary `make stack-up` already sees dev's
  walls. `staging` and `prod` are the other shapes, and `off` restores today's uncapped stack for anyone who wants the
  old behaviour. `LOAD_MEM` stays as a single override for every container.
- **A Fargate vCPU is slower than a laptop core.** `LOAD_CPU_FACTOR` scales every cap. Its default is calibrated in
  phase 2 against dev's measured CPU per page; the weekend's numbers put a Fargate vCPU at about 1.3–1.6× slower than
  an Apple-silicon core.
- **The databases are approximate.** RDS is its own instance class (the flavour's `rds.instance_class`), and
  postgres gets a CPU/memory cap in that class's range. The docs say it is an approximation.
- **Counting what ran out is Prometheus's job.** cAdvisor joins the monitoring stack, so every container's CPU against
  its cap, CPU throttling, memory against its limit, OOM kills and restarts are series. A run's verdict reads them.
- **Heavier means longer, page-level and burst-shaped, not just more VUs.** A page breakpoint finds landing-ui's
  knee. Spikes carry a recovery probe. Holds of 5 minutes or more let autoscaling show on AWS. A soak watches the
  memory slope.

## Phase 1 — this plan

## Phase 2 — every container at its AWS size

- `scripts/sync-fargate-sizes.mjs` + `stack/fargate-sizes.json`.
- `stack/stack.sh up` resolves `LOAD_FLAVOUR` and `LOAD_CPU_FACTOR` into a CPU and memory per service (`LOAD_CPUS_<SVC>`,
  `LOAD_MEM_<SVC>`) and prints the table it applied. `stack/docker-compose.yml` reads those in place of the shared
  `x-limits`.
- Infra keeps sensible caps: postgres approximating RDS, spg at its catalog size. The monitoring containers stay
  uncapped, so observing never becomes the bottleneck.
- **Calibration:** run the storefront browse at 30 shoppers against the capped stack. The factor is right when
  landing-ui's CPU per page and its saturation roughly match dev's run `browse-load-20260913T214244Z` (0.5 vCPU at
  90–96 %, ~95 ms of CPU per page). The chosen default goes into the knob's doc.
- **Calibration, as measured:** `LOAD_CPU_FACTOR=0.45`. Under dev's own load shape (storefront-browse, 30 shoppers,
  org1-store2, the same landing-ui build), dev's landing-ui spent 88–95 ms of CPU per page on 2026-09-13 (0.5 vCPU at
  90–96 %, run `browse-load-20260913T214244Z`: CloudWatch one-minute maxima × 0.5 vCPU ÷ 1,610 page views), and the
  capped stack here spent 41.6 ms (at a 0.325 cap, `load-load-20260914T000658Z`) and 42.1 ms (at 0.225,
  `calib-0.45-browse-load-20260914T010001Z`): 42 / 93 = 0.45. At 0.45 landing-ui sat at 90 %+ of its cap for 4m15s
  without a break, at 94 ms of Fargate CPU per page, as on dev. The first estimate, 0.64, came from a sequential render
  harness (60.7 ms a render, cvhome#356); one render at a time costs more than renders under load, so it overstated a
  Fargate vCPU. The derivation is in the knob's doc (`stack/stack.sh`, `docs/monitoring/load-testing.md`).
- **Verified:**
  - `docker inspect` shows each container's NanoCpus and Memory equal to dev's `ssr`/`medium`/`small`/`gateway` sizes
    × the factor.
  - The browse run reproduces dev's result: landing-ui at its cap, pages in seconds, catalog next.

## Phase 3 — containers in Prometheus

- **cAdvisor** in `stack/docker-compose.yml` and the aws-only monitoring compose, scraped by Prometheus.
- **Recording rules:**
  - `load:container_cpu:ratio` (CPU against the cap), `load:container_throttled:ratio`;
  - `load:container_memory:ratio` (working set against the limit);
  - OOM kills and restarts as counters.
- **Dashboards:** Load test vs app → *What ran out* gains per-container CPU against cap, throttling and memory against
  limit, plus the landing-ui Node runtime panels (event-loop delay, heap), which the collector already keeps.
  Changes go through `dashboards.spec.mjs` and both generators; `make monitoring-check` passes.

## Phase 4 — a verdict per run

- `make verdict TESTID=…`, and at the end of every `bin/k6run` unless `NO_VERDICT=1`. It queries Prometheus over the
  run's window and prints each container's peak CPU/cap, share of time throttled, peak memory/limit, OOMs and restarts,
  plus landing-ui's CPU seconds per page view.
- It fails on the budgets in `k6/config/budgets.js`:
  - CPU at 90 %+ of the cap for more than a minute;
  - memory above 85 % of the limit;
  - any OOM or restart;
  - landing-ui CPU per page above its budget.
- Budgets live beside `thresholds.js` and follow the same rule: the numbers are in one place.

## Phase 5 — heavier and page-shaped scenarios

- `storefront/page-breakpoint.js`: an open-model ramp of full page views (home, category, product, search) until a page
  SLO breaks. It is landing-ui's knee, where today's breakpoint only ramps two catalog APIs.
- Spikes get a recovery probe: one steady page view every few seconds, from before the spike to after it, with a
  threshold on its latency once the spike has ended.
- `platform/sign-in-burst.js`: sign-ins paced to the target's limiter (local 1000/min, deployed 10/min), with
  `seller:login-submit` per hop, so uaa's cost per sign-in under its cap is a number.
- `load` holds for 5 minutes by default (a deployed target's autoscaler reacts in 3–6), and `soak` for 30. Soak's
  verdict adds the memory slope: a working set that keeps rising after warm-up is a leak.

## Phase 6 — what a page ships

- `make page-budget`: for each theme (through `?theme=`) and each key page, the HTML bytes, the RSC payload bytes, the
  CSS and JS file counts and bytes, and any file that belongs to another theme. It uses the per-file attribution from
  cvhome-saas/cvhome#356.
- Budgets live in `k6/config/budgets.js`. It would have failed on both weekend findings: 12 themes on every page, and
  all CSS inlined twice.

## Phase 7 — an AWS run's report

`make aws-report TESTID=…`: CloudWatch over the run's window, read-only. It reports:

- every ECS service's CPU and memory, as one-minute maxima;
- running, desired and pending task counts, and scaling events;
- stopped tasks with their reason;

next to the k6 summary. It is what was done by hand this weekend. It needs AWS credentials, and says so when there are
none.

## Phase 8 — one command for the whole picture

- `make perf-suite`: on the capped stack, smoke → load → spike with recovery → page breakpoint → sign-in burst → a short
  soak, then the page budget. It ends with one table: each check, its number, its budget, pass or fail.
- `TARGET=aws make perf-suite` runs the same sequence minus the stack steps, with `aws-report` per run.

## Phase 9 — docs, QA and the first capped baseline

- **Docs:** README; `docs/monitoring/load-testing.md` ("What still differs from a deployment" shrinks); `docs/baseline.md`
  gets the first capped-stack run, next to dev's numbers from this weekend.
- **QA:** cases in `qa/load-testing-qa.md` for `LOAD_FLAVOUR`, the verdict, page-budget, aws-report and perf-suite.

## Gates

`npm test` (lint, `make inspect`, `make build`), `make monitoring-check`, then `scripts/verify.sh`. A capped `make
stack-up` and `make perf-suite` run end to end.

## Deviations as built

- **The CPU factor is 0.45, not the ~0.65 this plan expected.** Measured the way phase 2 says, under dev's own load
  shape, landing-ui spent 42 ms of CPU per page here and 88–95 ms on dev: 0.45. At 0.65 the local task had half again
  dev's capacity. The 0.64 estimate came from a harness that rendered one page at a time.
- **cAdvisor needed more than the plan knew.**
  - gcr.io's last cAdvisor (v0.52.1) cannot read a container under Docker's containerd image store, which is Docker
    Desktop's default. The stack runs `ghcr.io/google/cadvisor:0.55.1` with the containerd socket mounted.
  - The docker socket is mounted by its own path, because Docker Desktop maps `/var/run` to the Mac.
  - In the aws-only monitoring, cAdvisor sees only the monitoring containers. The platform's are on ECS, and
    `make aws-report` reads them.
- **The recorded CPU rules look 30 s back** (`offset 30s`). cAdvisor stamps a sample when it collects it, and a
  window ending now read up to a quarter low. The verdict reads the raw rates after the fact instead. The first suite
  showed why: uaa at 100 % read as a 45 s stretch and passed.
- **The collector was dropping the Node runtime series** this plan said it kept. Its filter now lets through four:
  event-loop delay p99 and utilisation, heap used and heap limit.
- **Beyond the plan:**
  - `LOAD_POOL_SIZE` follows the flavour's `db_pool_size` (3 on dev).
  - The monitoring is uncapped in every shape, `off` included; before, `LOAD_MEM` capped it too.
  - `LOAD_TAG_<SERVICE>` runs one service at another tag. The calibration image used it.
  - `make stack-sizes` and `make stack-limits` exist, and `stack.sh up` can run again over its own stack: a
    `grep -q` under `pipefail` used to refuse it.
- **The verdict:**
  - It skips smoke runs unless `VERDICT=1`.
  - It prints k6's crossed thresholds beside its container result. k6's thresholds still set the exit code for
    latency and errors.
  - A soak's memory slope counts only when 20 minutes follow the warm-up. Five minutes of a GC sawtooth read as a
    leak.
- **sign-in-burst paces at dev's 9 a minute**, not at the local limiter's 1000. A 0.25-vCPU uaa (0.1125 cores here)
  cannot absorb more: at 60 a minute every sign-in queued into 60 s timeouts.
- **Every seller sign-in is now timed per hop,** not only sign-in-burst's. `core/session.js` follows the redirects
  itself, so `seller:login-submit` is the password POST alone, next to `-authorize` and `-callback`.
- **The spike holds two minutes at base after the peak** (was one), so the recovery probe has a window.
- **page-budget attributes scripts only where it can read the build's manifests:** out of the local landing-ui
  container, or from `PAGE_BUDGET_BUILD`. Against AWS it attributes stylesheets only.
- **aws-report never ran against AWS.** The SSO session had expired, so only the no-credentials path is verified.
  `awsRegion` and `ecsClusterPrefix` joined the deployment files.
- **Images:**
  - The Spring services ran as the local `:native` images from the old GraalVM branch, which predate cvhome#354
    (uaa's client-secret check is still a bcrypt). The uaa and backend numbers carry that caveat.
  - landing-ui ran as `store-pod/landing-ui:calib-arm64`, a local-only arm64 image built from cvhome main
    `113caa92b`'s standalone output on node:20-alpine. It was never pushed and was deleted at the end.
- **The first suite run is not a baseline.** Another experiment sent storefront traffic to the stack's backend
  from 00:12 to 00:47 UTC, and the Mac slept from 00:15 to 00:32. It proved the mechanics only.
- **Follow-up for the orchestrator:** a contract check between `stack/fargate-sizes.json` and cvhome-platform's
  `flavours.yaml` and `services.yaml`. `npm test` runs `--check` only where a platform checkout sits beside this repo,
  and CI has none.

## Verification

**Images.** The Spring services ran as the local `:native` set, which predates cvhome#354. landing-ui ran as a
local-only arm64 image of cvhome main `113caa92b` (#356). It was deleted at the end.

- **Gates:**
  - `npm test`: audit, ESLint, Prettier, Markdownlint, `sizes:check`, `make inspect`, `make build`.
  - `make monitoring-check`: 12 dashboards and their docs, promtool on `cvhome-*` and `load-recording.yml`, both
    rule tests, the Prometheus and collector configs, both compose files.
  - ShellCheck (in Docker; it is not installed here) on `bin/k6run`, `scripts/*.sh` and `stack/stack.sh`.
  - `scripts/verify.sh` is green for the pushed tree.
- **Caps** (`docker inspect`, `LOAD_FLAVOUR=dev`, factor 0.45):
  - `NanoCpus` 225000000 for landing-ui, catalog, content, merchant, spg and store-core-gateway.
  - 112500000 for uaa, tenancy, billing, pod-registry, checkout, cua, payment, inventory and console-ui.
  - 900000000 for postgres. minio and the monitoring are 0.
  - `Memory` is 1073741824 for every JVM, landing-ui and spg, and 536870912 for console-ui. The monitoring is 0.
- **Calibration:** dev's `browse-load-20260913T214244Z` (88–95 ms of CPU per page at 0.5 vCPU) against
  `calib-0.45-browse-load-20260914T010001Z` (42.1 ms here, 94 ms Fargate, landing-ui at its cap for 4m15s).
- **perf-suite at the default,** 01:09–01:40 UTC, clean. Each run's checks, and whether they pass:

  | run | result |
  | --- | --- |
  | `smoke-smoke-20260914T010902Z` | thresholds pass |
  | `load-load-20260914T011020Z` | pages p95 6.3–8.3 s: FAIL. landing-ui at its cap 2m00s in one stretch: FAIL. Memory 51 %, OOM/restarts 0, 108 ms Fargate per page: pass |
  | `spike-spike-20260914T011845Z` | page p95 and 9 % home journey errors: FAIL. landing-ui at its cap 1m15s: FAIL. 166 ms per page: FAIL. Memory 42 %, OOM/restarts 0, recovery p95 0.92 s: pass |
  | `page-breakpoint-breakpoint-20260914T012303Z` | aborted at page:home p95 3.2 s, knee ≈ 3.8 page views/s. 135 ms per page: FAIL. Cap, memory, OOM: pass |
  | `sign-in-burst-load-20260914T012522Z` | sign-in p95 98 s: FAIL. uaa at its cap 2m45s: FAIL. 3.9 s of Fargate CPU per sign-in: reported. Memory, OOM: pass |
  | `soak-soak-20260914T012913Z` | pages p95 3.2–4.6 s: FAIL. Cap, memory, OOM, restarts: pass. catalog +32 %/h: reported, not judged on 10 min |
  | page budget | 48 of 48 pages pass, 0 files of another theme |

  In all, 25 checks failed. The failures are dev's walls at dev's sizes, plus the old uaa image.
- **Page budget on the old storefront** (`store-pod/landing-ui:native`, fashion, basic and grocery): 12 of 12 over.
  Each page loaded 11 scripts of another theme and carried 288 KiB of inline CSS twice, at 700–846 KiB of HTML.
- **Other checks:**
  - `make selftest`: 102 of 102 checks with the per-hop sign-in.
  - The verdict re-read runs after the fact, and `NO_VERDICT` / `VERDICT=1` behaved as documented.
  - aws-report printed its no-credentials line and exited 2.
  - The stale-copy check failed on an edited copy and was byte-identical after the sync.
  - QA: 18 of 27 cases verified; 06.10 only on its no-credentials path.
- **Not verified:**
  - aws-report against AWS (the SSO session had expired).
  - `TARGET=aws make perf-suite`.
  - The new panels looked at in a browser; their queries were checked against Prometheus.
  - A 30-minute soak with the leak judgement on.
  - The stack at `staging`, `prod` or `off` started end to end (only the table).
  - JVM images at these caps.
  - The calibration on another machine.
