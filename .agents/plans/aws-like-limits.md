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

## Verification
