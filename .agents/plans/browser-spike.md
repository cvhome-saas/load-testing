# The storefront spike, seen from a browser

One PR, `feat/browser-spike`, one commit per phase, easiest first. It lives in load-testing alone: the storefront
image already has the CDN mode phase 2 turns on, and no platform size or route changes.

## Context

- **The spike exists, but only as HTTP.** `storefront-browse` at `PROFILE=spike` (`k6/config/profiles.js:31`) takes
  shoppers to 10× for a minute, with a recovery probe (`profiles.js:83`). It sends what an HTTP client sends: the
  document and the API reads beside it. It never loads a page's static files or runs its JavaScript, and never calls
  catalog from the browser (the search box's suggest). It cannot say what a shopper sees: LCP, TTFB.
- **The browser scripts have no spike.** `browserScenario()` (`profiles.js:93`) is `shared-iterations` with a fixed
  count of Chromium VUs. There are no phases, so a spike's peak and its recovery land in one number. The browser module
  names every request by its URL, so `browser_http_req_duration` has one series per product page.
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
- **Every browser request is named by its kind.** `page.on('metric')` renames `url` and `name` to one of:
  `page:<kind>`, `rsc`, `static`, `api:<service>`, `media`, `other`. Web Vitals take the page's name, so LCP reads per
  kind of page. The naming lives in `withPage()`, so every browser journey gets it.
- **The stack serves static files as AWS does.** landing-ui publishes them to a MinIO bucket at boot through its own
  CDN mode. The bucket is `storefront-assets`, public-read, and a one-shot `minio-init` creates it before landing-ui
  starts. `LOAD_CDN=false` goes back to origin serving.
  - MinIO is uncapped, as CloudFront is to a task.
  - What still differs: MinIO serves uncompressed HTTP/1.1 where CloudFront serves brotli over HTTP/2. Over
    localhost the bytes cost no time worth measuring.
- **Thresholds per phase.**
  - Before and after the spike, a page meets the plain browser SLO: LCP p75 4 s, TTFB p75 1.5 s, catalog from the
    browser p95 800 ms, failed visits under 2 %.
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

## Phase 3 — browser requests named by their kind (commit 3)

- `k6/lib/journeys/browser/context.js`: `nameRequests(page)` in `withPage()`, one ordered rule list, and a catch-all
  that matches only a URL, never a name that is already set.
- `k6/lib/journeys/browser/pages/storefront.js`: navigation through one `visit()`, which counts
  `browser_page_views`.
- `k6/lib/core/metrics.js`: the counter. `scripts/verdict.mjs`: the page-view unit adds it.

## Phase 4 — `browser-storefront-spike` (commit 4)

- `k6/config/profiles.js`: the spike's phase windows next to `SPIKE`, and `browserPhases(exec)`: three browser
  scenarios at spike, one iteration at smoke.
- `k6/config/thresholds.js`: `browserSpike(profile)`. The browser layer's latency lines honour `MULTIPLIER`.
- `k6/lib/core/env.js`: `BROWSER_SPIKE_VUS` (0 means 3 × `BROWSER_VUS`).
- `k6/lib/journeys/browser/visit.js`: `browserVisit(store, data, page)`. `Storefront.suggest(term)`.
- `k6/lib/journeys/shopper/browse.js`: `browseVisit(store, data)`, the body of `storefront-browse`'s shopper, so both
  spikes send the same traffic. `k6/scripts/storefront/browse.js` calls it.
- `k6/scripts/browser/storefront-spike.js`: the spike at every profile except smoke.

## Phase 5 — perf-suite, docs, QA (commit 5)

- `scripts/perf-suite.mjs`: a `browser-spike` step after `spike`, and a row per phase: LCP and TTFB p75, and catalog
  from the browser p95.
- README → *Scripts* row, knobs, the stack's CDN; `docs/coverage.md`; `docs/monitoring/load-testing.md`, the spike
  section; `docs/baseline.md`, the run.
- `qa/load-testing-qa.md`: the stack's CDN; the browser spike's phases; request names; the perf-suite step.

## Other repos

None. The CDN mode is landing-ui's own (`storefront/start.mjs`, `scripts/static-assets/`), and phase 2 only sets its
environment. The `STATIC_ASSETS_*` names become one more fact copied out of cvhome, and the cross-repo review names
it. A real run wants images of cvhome main, built by the person as the stack's pre-step.

## Deviations, as built

## Verification
