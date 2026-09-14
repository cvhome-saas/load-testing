# The storefront spike, seen from a browser

One PR, `feat/browser-spike`, one commit per phase, easiest first. It lives in load-testing alone: the storefront
image already has the CDN mode phase 2 turns on, and no platform size or route changes.

## Context

- **The spike exists, but only as HTTP.** `storefront-browse` at `PROFILE=spike` (`k6/config/profiles.js:31`) takes
  shoppers to 10× for a minute, with a recovery probe (`profiles.js:83`). It sends what an HTTP client sends: the
  document and the API reads beside it. It never loads a page's static files or runs its JavaScript, and never calls
  catalog from the browser (the search box's suggest). It cannot say what a shopper sees: LCP, TTFB.
- **The browser scripts have no spike.** `browserScenario()` (`profiles.js:93`) is `shared-iterations` with a fixed
  count of Chromium VUs. There are no phases, so a spike's peak and its recovery land in one number.
- **On the load stack, landing-ui serves its own static files; on AWS it does not.** On AWS, landing-ui's `start.mjs`
  uploads `.next/static` to S3 at boot, and browsers load it from CloudFront (`STATIC_ASSETS_*` in cvhome-platform
  `modules/store-pod/main.tf`). `stack/docker-compose.yml` sets none of it, so landing-ui serves `/_next/static`
  itself. A first visit loads 14–16 scripts and 2 stylesheets, about 1.2 MiB (`docs/baseline.md`, the page-budget row).
  On the stack every one of those files comes off landing-ui's 0.225-core cap: a load dev never has.
- **The verdict counts page views from HTTP only.** It reads `k6_http_reqs_total{name=~"page:.*"}`
  (`scripts/verdict.mjs:25`), so a browser's documents are rendered but never counted.
- **What the spike found so far.**
  - Dev, 8 → 300 shoppers: landing-ui at 100 % CPU and 4.8 % of requests timed out (the orchestrator's
    `landing-ui-cpu-memory` plan).
  - The capped stack, `spike-spike-20260914T011845Z`: pages p95 60 / 30 / 18.5 s, and 9 % of home journeys failed.
    It recovered within 20 s.

  Neither run says what that was like in a browser.

## Why the design is what it is

- **Hybrid: HTTP shoppers are the load, browsers are the measurement.** This is Grafana's recommended practice. A
  Chromium instance costs this machine a core while it renders, plus a few hundred MB. A hundred of them would make the
  generator the bottleneck, not landing-ui.
  - The load is `storefront-browse`'s spike: its shape and its journeys, so the numbers line up with
    `spike-spike-…` and with dev's.
  - The browsers are shoppers measured through the spike. They spike too, from `BROWSER_VUS` to `BROWSER_SPIKE_VUS`,
    so the peak has samples.
- **Each phase is its own scenario, not one ramping browser scenario.** The windows come from `SPIKE` in `profiles.js`,
  the one place the shape lives:
  - `ui-base`: the 30 s before the spike;
  - `ui-peak`: the minute at 10×;
  - `ui-recovery`: from 20 s after the spike to the end, the window the HTTP recovery probe already uses.

  `scenario` is already a system tag. Thresholds, the summary and Prometheus split by phase with no new tag.
- **One page per iteration, in a fresh browser context.** A campaign's shoppers arrive with nothing cached. Each sample
  belongs to one phase, and 1–3 s of think time makes a browser weigh what an HTTP shopper weighs. The page comes from
  `pageMix`, the page-breakpoint's mix.
- **On the home page, the shopper types a search term.** This is catalog's suggest endpoint, called from the browser,
  plus an interaction for INP. The step is skipped when the store's layout keeps the search box out of the header.
- **Every browser metric carries its journey.** `withPage()` sets the journey on the VU for the life of the page, next
  to the module's own `resource_type`. A visit's journey is `visit-<page>`, so LCP reads per kind of page and
  `resource_type:Fetch` is the storefront's API calls from the browser. (The plan first had `page.on('metric')` rename
  every request; see Deviations.)
- **The stack serves static files as AWS does.** landing-ui publishes them to a MinIO bucket at boot through its own
  CDN mode. The bucket is `storefront-assets`, public-read, and a one-shot `minio-init` creates it before landing-ui
  starts. `LOAD_CDN=false` goes back to origin serving.
  - MinIO is uncapped, as CloudFront is to a task.
  - What still differs: MinIO serves uncompressed HTTP/1.1 where CloudFront serves brotli over HTTP/2. Over
    localhost the bytes cost no time worth measuring.
- **Thresholds per phase.**
  - Before and after the spike, a page meets the plain browser SLO: LCP p75 4 s, TTFB p75 1.5 s, the storefront's
    API calls from the browser p95 800 ms, failed visits under 2 %.
  - At the peak, the spike's 3× and failed visits under 5 %: a shopper may wait, but should not get an error.
  - The HTTP background keeps the storefront layer's spike SLO, as `storefront-browse` has it.
  - The browser layer's run-wide latency lines now honour `MULTIPLIER`, as every other layer's do.
- **The verdict counts browser page views.** A `browser_page_views` counter goes up on every document navigation.
  `landing-ui` CPU per page view reads HTTP and browser page views together.

## Phase 1 — this plan (commit 1)

## Phase 2 — the stack serves static files as CloudFront does (commit 2)

- `stack/docker-compose.yml`:
  - `minio-init`, one-shot, on the same MinIO image and its `mc`, creates `storefront-assets` and makes it
    public-read;
  - landing-ui gets `STATIC_ASSETS_*`, S3 endpoint `http://minio:9000`, path-style, and base URL
    `http://localhost:9000/storefront-assets/storefront`, which is what the browser on this machine loads;
  - landing-ui waits for `minio-init` to complete;
  - `LOAD_CDN` (default `true`).
- `stack/stack.sh` documents `LOAD_CDN`. After `up`, it prints whether landing-ui synced or fell back to origin.

**Gates:** `docker compose config -q`, `make monitoring-check`. A capped `make stack-up` shows the sync in
landing-ui's log, and a page's HTML carries no origin-relative `/_next/static`.

## Phase 3 — browser metrics: the journey, no HTTPS detour, counted pages (commit 3)

- `bin/k6run`: `disable-features=HttpsUpgrades` in `K6_BROWSER_ARGS`.
- `k6/lib/journeys/browser/context.js`: `withPage()` sets `journey` on the VU, and removes it once the page and its
  context have closed.
- `k6/lib/journeys/browser/pages/storefront.js`: navigation through one `visit()`, which counts
  `browser_page_views`.
- `k6/lib/core/metrics.js`: the counter. `scripts/verdict.mjs`: the page-view unit adds it.

## Phase 4 — `browser-storefront-spike` (commit 4)

- `k6/config/profiles.js`: the spike's phase windows next to `SPIKE`, and `browserPhases(exec)`: three browser
  scenarios at spike, one iteration at smoke.
- `k6/config/thresholds.js`: `browserSpike(profile)`. The browser layer's latency lines honour `MULTIPLIER`.
- p75 in a browser run's summary (`build()`) and in Prometheus (`K6_PROMETHEUS_RW_TREND_STATS` in `bin/k6run`).
- `k6/lib/core/env.js`: `BROWSER_SPIKE_VUS` (0 means 3 × `BROWSER_VUS`).
- `k6/lib/journeys/browser/visit.js`: `browserVisit(store, data, page)`. `Storefront.suggest(term)`.
- `k6/lib/journeys/shopper/browse.js`: `browseVisit(store, data)`, the body of `storefront-browse`'s shopper, so both
  spikes send the same traffic. `k6/scripts/storefront/browse.js` calls it.
- `k6/scripts/browser/storefront-spike.js`: the spike at every profile except smoke.

## Phase 5 — perf-suite, docs, QA (commit 5)

- `scripts/perf-suite.mjs`: a `browser-spike` step after `spike`, and a row per phase: LCP and TTFB p75, the API
  calls from the browser p95, and failed visits.
- README → *Scripts* row, knobs, the stack's CDN; `docs/coverage.md`; `docs/monitoring/load-testing.md`, the spike
  section. `docs/baseline.md` gets the first run on images of cvhome main (see Verification).
- `qa/load-testing-qa.md`: the stack's CDN; the browser spike's phases; request names; the perf-suite step.

## Other repos

None. The CDN mode is landing-ui's own (`storefront/start.mjs`, `scripts/static-assets/`), and phase 2 only sets its
environment. The `STATIC_ASSETS_*` names become one more fact copied out of cvhome, and the cross-repo review names
it. A real run wants images of cvhome main, built by the person as the stack's pre-step.

## Deviations, as built

- **`page.on('metric')` could not name requests, so the journey does.** Measured with a one-page script and k6's JSON
  output:
  - Without the `url` system tag, which bin/k6run drops for HTTP's sake, the browser module sets neither `url` nor
    `name` on anything, and `metric.tag()` has nothing to match.
  - With `url` on, every `tag()` call is matched against the original URL. The last matching rule wins, so the
    catch-all renamed everything to `other`.

  Turning `url` on would give every HTTP request of the same run a raw-URL tag. So the context's premise was wrong:
  browser metrics here never had per-URL series. What they lacked was a way to tell pages apart. The VU-level
  `journey` tag reaches every browser metric, Web Vitals included, and the module already tags `resource_type`.
- **Chromium tried every local navigation over https first.** HttpsUpgrades turned `http://…/en` into an internal 307
  to `https://…/en`, which spg's :443 held for 3 s before Chromium fell back to http. Every local browser TTFB and LCP
  carried those 3 s: a home page's TTFB was 3.86 s with it and 0.96 s without, on the same image. On AWS the storefront
  is https, so the detour never happened there. bin/k6run turns the feature off.
- **The Web Vitals panels had never drawn.** `K6_PROMETHEUS_RW_TREND_STATS` exported p95/p99/avg/max/min, but the Load
  test vs app stats read `k6_browser_web_vital_*_p75`, which did not exist. bin/k6run now exports p75 too, and a
  browser run's summary shows it.
- **The seeded home pages embed a YouTube player.** A browser visit loads its scripts, an iframe and beacons from the
  internet. They are in the `browser_*` numbers, as they are for a shopper. The Document threshold is TTFB, which
  is the storefront's own document.

## Verification

**Images.** Only the old images were on this machine: the Spring services as the `:native` set from before
cvhome#354, and `store-pod/landing-ui:latest`/`:native` (amd64, 2026-09-13, from before #356 and #357, emulated on this
arm64 host). They prove the mechanics. Their numbers describe no storefront: that landing-ui cost 742–827 ms of
Fargate CPU per page view, against dev's ~95 ms. None of them is recorded in `docs/baseline.md`.

- **Gates:**
  - ESLint, Prettier, Markdownlint (README and docs), `sizes:check`, `make inspect`, `make build`;
  - ShellCheck (in Docker; it is not installed here) on `bin/k6run`, `scripts/*.sh` and `stack/stack.sh`;
  - `docker compose config -q`, with and without `LOAD_CDN=false`;
  - `scripts/verify.sh` for the pushed tree.
- **Phase 2:** `LOAD_TAG=native stack/stack.sh up` at dev/0.45.
  - `minio-init` exited 0 ("Bucket created", "download").
  - landing-ui logged "uploaded 173 files" and `asset prefix set to http://localhost:9000/storefront-assets/storefront`,
    and `stack.sh up` printed it.
  - A home visit loaded its scripts from `localhost:9000`.
  - `LOAD_CDN=false`: prefix `''`, and 906 origin-relative `/_next/static` references on the home page.
  - Back to the CDN: "already synced — skipping upload".
  - A recreated landing-ui was still uploading when `stack.sh up` read its log, so `up` now waits for the line, for up
    to 60 s.
- **Phase 3:**
  - The two `page.on('metric')` runs and the HttpsUpgrades A/B are under Deviations.
  - `storefront-spike-smoke-20260914T064318Z`: every browser series carried `journey` and `resource_type`, the
    Document answered 200 with no 307, and `browser_page_views` was 1.
  - After the change, `browser-browse` at smoke counted 4 page views, with TTFB p75 0.84 s.
- **Phase 4:**
  - `k6 inspect -e PROFILE=spike -e PEAK_VUS=10`: `shoppers` 3 → 100 → 3 over 3m50s; `ui-base` 3, `ui-peak` 9 and
    `ui-recovery` 3 Chromium VUs at 0 s / 40 s / 2m10s; 31 threshold lines.
  - `mech-storefront-spike-spike-20260914T064445Z` (`PEAK_VUS=2`): every per-window line in the summary; failed visits
    13 % / 100 % / 0 %; the verdict counted 122 page views, 67 of them browsers'.
  - `storefront-browse` at smoke after the move to `browseVisit()`: 17 checks, 0 failed.
- **Phase 5:** `SUITE_STEPS=browser-spike SUITE_SPIKE_VUS=2 node scripts/perf-suite.mjs`
  (`browser-spike-spike-20260914T065128Z`): the three rows, with `-` where the peak had no finished visit.
- **The recorded runs** (`docs/baseline.md`, *The storefront spike in a browser*):
  - The person chose to build landing-ui alone from cvhome main `e220976a8`: a local-only arm64 image on
    `node:24-alpine`, deleted after the runs. The `:native` backend stayed, as in the capped rows before it.
  - `storefront-spike-spike-20260914T071803Z` and `…T072333Z` at `PEAK_VUS=10`:
    - LCP p75 1.1 s before and after the spike, 8.0–9.6 s during it; 14–16 % of peak visits got no page in 30 s.
    - landing-ui at its cap for 45 s, at 61–67 ms of Fargate CPU per page; catalog at 74–77 % of its cap.
- **Not verified:**
  - `TARGET=aws` (dev serves https and CloudFront; the script needs nothing new for it).
  - The Web Vitals stats on Load test vs app opened in a browser. Their `_p75` series now exist in Prometheus.
