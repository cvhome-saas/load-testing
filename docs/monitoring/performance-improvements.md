# Performance: what the first load tests found, and what was done about it

The issues the first measured runs surfaced, in enough detail to plan work later. Each entry says what was seen,
how it was measured, where to look at it, what was found to be the cause, and — where a fix has landed — what
changed and how it was verified. Issues without a code fix say what still has to be measured.

The runs (2026-09-06, local stack: one JVM per service on one machine, PostgreSQL 15, Hikari pool 5 per service,
storefront on `next dev`): smoke, `storefront-browse` 30 VUs, `shopper-guest-checkout` 40/min, `mixed-production-mix`,
`storefront-breakpoint` ramp to 150 iterations/s. Numbers and test ids: `../../docs/baseline.md` (the
`load-testing` repo). Dashboards named below are the provisioned Grafana ones; their queries are in
[dashboards.md](dashboards.md), the KPIs in [kpis.md](kpis.md).

## Summary

| # | issue | severity | where | status |
| --- | --- | --- | --- | --- |
| 1 | Storefront pages take 4.5–5 s at p95; the APIs behind them answer in milliseconds | high for the user, but measured on the dev server | landing-ui | open: measure on a built storefront first |
| 2 | catalog ran ~21 SQL statements per request; the product page loaded option values and their labels row by row | high, grows with the catalogue | catalog | **fixed**: batch fetching, 8 statements per product page |
| 3 | 132 k `SELECT cvhome` statements — a third of catalog's SQL hidden behind one span name | medium | catalog / collector | **fixed**: the collector names them from the statement |
| 4 | checkout ran ~11 statements per request; every insert cost two sequencer round-trips | medium | checkout, every pod | **fixed**: fifty ids per fetch |
| 5 | Admin traffic in the production mix failed 2 % with 403s | medium, a test-fixture problem | load-testing sessions | **fixed** in `load-testing`: sessions picked by role |
| 6 | `catalog → merchant` was the slowest service-to-service edge (p95 0.79 s) | medium | uaa (the s2s token endpoint) | **fixed**: one bcrypt per token request, 0.53 s → 0.3 s |
| 7 | `landing-ui → spg` showed 4–6 % failed calls | low | catalog public reads | **fixed**: absent strips answer an empty group, not 404 |
| 8 | No knee found: the API tier's capacity is unknown above 552 req/s | measurement gap | load-testing | open |
| 9 | 409s on category attach under concurrent catalogue edits | expected behaviour | catalog | no change |
| 10 | Login and redirect paths are the slowest routes on uaa and the gateway | low | uaa, gateway | partly: the `UNKNOWN` route on uaa is the token endpoint, see 6 |

## 1. Storefront pages: 4.5–5 s at p95 — a dev-server measurement; 0.07–0.09 s built

- **Seen.** `page:home` 4.99 s, `page:product` 4.72 s, `page:category` 4.66 s at p95 in the browse run (threshold
  3 s); the same ~4.4 s in the production mix. Server-side renders in landing-ui: `GET /[locale]` 4.73 s,
  `GET /[locale]/product/[url]` 4.73 s, `GET /[locale]/category/[url]` 4.70 s, `GET /[locale]/search` 4.51 s, while
  `GET /[locale]/checkout` is 1.24 s.
- **What the APIs did meanwhile.** catalog product 14 ms, search 27 ms, products-by-category 16 ms, inventory
  availability 4 ms, content layout under 50 ms — all at p95, all under their thresholds by 20× or more. spg's own
  p95 (2.6 s) is landing-ui's time seen from the gateway.
- **Cause.** The stack runs the storefront with `next dev` (Turbopack, no build), which compiles on demand and does
  no caching; the time is inside the render, not in the upstream fetches.
- **Measured on a built storefront** (`npm run build` at `store-pod/landing-ui`, then `node start.mjs` with
  `PORT=8110 OTEL_SDK_DISABLED=false` in place of the lcl-managed dev server; `storefront-browse` at
  `PROFILE=load`, 30 VUs, 3 min hold, test id `browse-load-20260906T124154Z`, after the fixes below):

  | page (k6, p95) | dev server | built |
  | --- | --- | --- |
  | `page:home` | 4.99 s | 91 ms |
  | `page:product` | 4.72 s | 73 ms |
  | `page:category` | 4.66 s | 79 ms |
  | landing-ui render p95 (`GET /[locale]`, `/product`, `/category`, `/search`) | 4.5–4.7 s | 91–98 ms |

  14,055 requests, 0 failed, 86 app req/s; catalog, content, inventory and merchant all at 48 ms p95. The
  platform has no storefront latency problem; the dev server has. Every storefront number in
  `load-testing/docs/baseline.md` taken before this run is a dev-server number.
- **Where.** Edge → *Page render p95* and *Upstream fetch p95 by call*; Load test vs app → *k6 p95 by endpoint*
  against *App p95 by service*.
- **Left.** lcl still starts `next dev`, which is right for development. A stack meant for load numbers should run
  the built storefront; the swap above is the recipe until lcl grows a flag for it.

## 2. catalog: ~21 SQL statements per request (N+1 on the product page) — fixed

- **Seen.** `cvhome:sql_per_request:ratio5m` for catalog was 21.3 during the browse run (checkout 11, every other
  service about 7). Over the 3 h of runs catalog served 28,560 `GET /api/v2/product/name/{friendlyUrl}` requests
  and ran:

  | statement family | count | per product request |
  | --- | --- | --- |
  | `SELECT cvhome` (joins the instrumentation could not name — see issue 3) | 132,024 | 4.6 |
  | `SELECT catalog.product_option_value_description` | 61,903 | 2.2 |
  | `SELECT catalog.product_variant` | 35,921 | 1.3 |
  | `SELECT catalog.category_description` | 32,806 | 1.1 |
  | `SELECT catalog.product_option_value` | 31,468 | 1.1 |
  | `SELECT catalog.product_option_assignment` | 28,575 | 1.0 |
  | `SELECT catalog.product_description`, `product_image`, `product`, `product_type`, `manufacturer` | 2,300–4,100 each | ≈ 0.1 |

- **Cause.** A product page trace (Traces → *N+1 suspects*) showed the shape: one query for the product with its
  copy, images, brand and type; one for its categories; one for the variants; then, for each assigned option,
  one query for its values, and for each value one query for its labels
  (`ProductOption.values`, `ProductOption.descriptions`, `ProductOptionValue.descriptions` were the only
  collections on the page without Hibernate's `@BatchSize`). A product with one option and five values cost five
  label queries; the count grows with options × values.
- **Fix.** `@BatchSize(size = 100)` on those three collections (`catalog-core` entities `ProductOption` and
  `ProductOptionValue`), the same device the product's own collections already used.
- **Verified.** The same product page after the change: 8 statements — product, categories, category labels,
  variant count, variants (one hydrated query), option assignments, option values, value labels — whatever the
  number of values. Under the browse mix re-run (`browse-load-20260906T124154Z`) catalog averaged **5.7**
  statements per request (was 21.3); Database & SQL → *Statements per request* is the KPI to watch.
- **Left.** The category read still costs two statements (categories, then their labels), the variant count one;
  they are one query each, not per row, and were left alone.

## 3. 132 k `SELECT cvhome` statements on catalog — fixed in the collector

- **Seen.** The most frequent JDBC span on catalog was `SELECT cvhome` — a SELECT whose table the instrumentation
  could not name (the span name falls back to the database name), 4.6 per product request; also 579 on checkout
  in the same period.
- **Cause.** Read from `db.statement` on a sample (Tempo: `{resource.service.name="catalog" && name="SELECT
  cvhome"}`): every one is a Hibernate join or subquery — the product fetched with its descriptions, images,
  brand and type; the category with its parent; the variants with their option values; checkout's order with
  its lines; the outbox poller's `not exists (…)` query. The OpenTelemetry JDBC instrumentation sets
  `db.sql.table` only for single-table statements, so multi-table statements lost their name and their
  `db_sql_table` dimension, and a third of catalog's SQL sat behind one row on the SQL panels.
- **Fix.** `stack/monitoring/otel-collector.yml`, processor `transform/span_names`: for a JDBC span
  without `db.sql.table`, the first table after `FROM` / `INTO` / `UPDATE` in `db.statement` becomes
  `db.sql.table`, and a span still named `<operation> <database>` is renamed `<operation> <table>`. No
  application change; the span metrics' `db_sql_table` dimension and the per-table recording rules see every
  statement.
- **Verified.** After the collector restart, catalog's span metrics show no `SELECT cvhome`; the joins appear as
  `SELECT catalog.product`, `SELECT catalog.product_category`, `SELECT catalog.outbox_record`, with
  `db_sql_table` set. Porting note: on another provider the same rule is a span processor keyed on the statement
  text; the regex is in the collector file.

## 4. checkout: ~11 statements per request, two sequencer round-trips per insert — fixed

- **Seen.** 11.2 statements per request during the checkout and mix runs. Per order (579 orders in 3 h):
  `UPDATE checkout.sm_sequencer` and `SELECT checkout.sm_sequencer` 2,154 each (3.7 per order), `customer_account`
  1.7, `sales_order_total` 1.4, `sales_order` 1.0, `sales_order_event` 1.0, `cart_line` 0.8.
- **Cause.** Every pod entity takes its id from a `@TableGenerator` on the `sm_sequencer` table with
  `allocationSize = SchemaConstant.DESCRIPTION_ID_ALLOCATION_SIZE`, and that constant was **0**: Hibernate's
  "no optimizer", one `SELECT` plus one `UPDATE` on the sequencer row per id, on a second connection from the
  pool, inside the request. An order with its lines, totals and event paid seven extra statements, and every
  order in flight serialised on the same rows. The same applied to every insert in catalog, payment and the
  other JPA pods.
- **Fix.** The constant is 50 (`store-pod/commons/store-commons/.../SchemaConstant.java`), and
  `common-config.yml` sets Hibernate's `id.optimizer.pooled.preferred: pooled-lo`. The optimizer choice is
  load-bearing: Hibernate's default `pooled` reads the sequencer row as the *last* id of a block and handed out
  negative ids against the seeded rows (the catalog integration tests caught it); `pooled-lo` reads it as the
  *first* id of the next block, which is what the rows already hold from the one-id-per-fetch days and what the
  seeds write, so existing databases migrate without a script. Ids stay unique and increasing; a restart skips
  what its JVM had left of the block, so they are no longer consecutive.
- **Verified.** On the live database (154 orders, last id 1154, sequencer row 1154): two smoke orders got 1155
  and 1156, the rows advanced by fifty, and the two orders together cost eight sequencer fetches — one per table
  touched, for the next fifty inserts of each. Product-group creation in the catalog integration tests passes
  against the seeded ids. Under `guest-checkout` and the mix re-run (`production-mix-load-20260906T125109Z`)
  checkout averaged **5.7** statements per request (was 11.2), 121 orders, 0 failed, checkout p95 86 ms.

## 5. Admin traffic fails 2 % with 403s in the production mix — fixed in `load-testing`

- **Seen.** `http_req_failed{layer:admin}` 2 % (threshold 2 %) in `production-mix-load`: 403 on
  `tenancy:store-unique` (19), `tenancy:store`, `tenancy:store-info`, `billing:entitlement`, `merchant:store-private`
  (4 each). Server side: `tenancy /api/v1/store-manager/private/store/unique` 403 ×13, `merchant
  /api/v1/private/store` 403 ×4, `billing /api/v1/entitlement/private/snapshot` 403 ×3 and 404 ×21. All from the
  advice (`AccessDeniedException`), so the tokens were valid and the permission check refused them.
- **Cause.** The session pool logs in four seeded accounts — org admin, store admin, super admin, store moderator —
  and the `store-reads` journey ("the org admin's store screens": org-level tenancy and billing reads) took
  whichever session the VU number pointed at. A store admin or moderator is refused on those endpoints by design,
  so a quarter to a half of the admin reads were 403 before they started. The 404s on the entitlement snapshot
  are the fixture store having no subscription yet.
- **Fix.** `k6/lib/core/session.js` gained `sessionWithRole(sessions, vuId, roles)`; `admin/store-reads.js`,
  `mixed/production-mix.js` and `smoke.js` ask for an `ORG_ADMIN` session for that journey (falling back to the
  pool when none logged in, as on a target without that account).
- **Verified.** `admin/store-reads` at the smoke profile after the change: 12 admin requests, 0 failed, and no
  403 on tenancy, billing or merchant in the ten minutes around it (Auth → *401 / 403 by service*). The mix
  re-run: 699 admin requests, **0 failed**, no 403 on any service (was 2 %). The admin threshold now measures the
  platform.

## 6. `catalog → merchant` is the slowest service-to-service edge — fixed at the token endpoint

- **Seen.** p95 0.79 s on the `catalog → merchant` edge (client side) during the checkout run, versus 0.05 s on
  `catalog → content` and `catalog → billing`. The server side of merchant is fast (its p95 is under 50 ms).
- **Cause.** A trace of one slow call: the client span starts, nothing happens for ~640 ms, then merchant
  receives the request and answers in 58 ms. The gap is the OAuth2 client-credentials exchange with uaa that the
  service-to-service client performs when its token has expired (every 15 min per service; the token client is
  not traced, so it shows as a gap). uaa's `POST /oauth2/token` took 0.51–0.65 s, with two ~250 ms pauses after
  two reads of the registered client: uaa's grace-aware client authentication
  (`GraceAwareClientSecretAuthenticationProvider` in `sso-core`) verified the live secret's bcrypt hash once to
  choose a registry view, then Spring's provider verified the same hash again. Two bcrypt rounds per token
  request, plus the same client read twice. This is also the `UNKNOWN` route on uaa in issue 10.
- **Fix.** The provider lets Spring's provider try the live registration first and consults the retired-secret
  history only after an `invalid_client` refusal. One hash per request on the common path; the grace window
  behaves as before (unit test asserts one encoder call and no history read for the live secret).
- **Verified.** uaa restarted: `POST /oauth2/token` 0.26–0.32 s (was 0.51–0.65 s) on both the accepted and the
  refused path. The remaining cost is one bcrypt at strength 10 on this machine. If the edge still matters, the
  levers left are the s2s token lifetime (900 s in the uaa seed, `settings.token.access-token-time-to-live`) and
  tracing the token client so the exchange stops showing as a gap.

## 7. `landing-ui → spg` shows 4–6 % failed calls — fixed

- **Seen.** `cvhome:s2s_failed:ratio_rate5m{client="landing-ui",server="spg"}` 4.2 % during the checkout run and
  5.6 % in the mix; over 3 h, 760 of 19,059 calls flagged failed, all on landing-ui's un-normalised client spans
  named `GET`.
- **Cause.** Their `url.full` (Traces → `{resource.service.name="landing-ui" && span:kind=client &&
  status=error}`): every one a 404 from `catalog /api/v1/products/groups/FEATURED_ITEMS` (the home page's
  strips) or `catalog /api/v1/products/{id}/relationship` (the product page's "you may also like"). The
  storefront treats both as optional and renders without them, but catalog answered 404 when the store had no
  such group, and a 4xx marks the client span as an error, so every home and product render of a store without
  those groups counted as a failed edge call.
- **Fix.** The storefront reads (`GET /products/groups/{code}` and `GET /products/{id}/relationship`) answer an
  empty, inactive strip (`active: false`, `products: []`) when the store has none; the console's private reads
  still 404 (`ProductGroupService.storefront(...)`, `related(...)`). Unit and integration tests updated; QA case
  GRP-07 in `store-pod/catalog/catalog-service/qa/catalog-qa.md` corrected.
- **Verified.** Both reads answer 200 with the empty strip on the live stack for a store without the groups; the
  storefront renders as before. Under the browse mix re-run the `landing-ui → spg` failed ratio was **0** (was
  4–6 %); anything that shows there now is a real failure worth a look.

## 8. The knee was not found — twice

- **Seen (first ramp).** 150 iterations/s = 552 app req/s with every threshold intact: product p95 9 ms, pool 20 %,
  threads under 1 %, system CPU 29 %, 0 failed, 0 dropped iterations.
- **Seen (re-run, `MAX_RPS=600 RAMP=6m`, test id `breakpoint-breakpoint-20260906T125416Z`, after the fixes).**
  Peak 1,200 k6 req/s = **1,540 app req/s**, 288,358 requests, 0 failed, 0 dropped, product p95 9.4 ms and
  availability 4.1 ms at peak (k6), catalog server p95 inside the 50 ms bucket throughout. Saturation at peak:
  catalog pool 40 %, request threads 1 %, **system CPU 71 %**. CPU is the first resource to approach its limit
  on this one-machine stack; nothing else moved.
- **Known.** The API tier's knee is above 1,500 req/s here, and it will be CPU-bound when it arrives. SLOs can be
  set against that; a single-machine number says nothing about Fargate task sizing, where each service has its
  own CPU.
- **Still to measure.** A ramp to 2,000+ req/s with more pre-allocated VUs (the generator held 50; watch *Dropped
  iterations* — above 0 the generator is the limit), and the same for `shopper/cart` and
  `shopper/inventory-contention`, which write. Read the knee on Bottlenecks → *Traffic vs p95* and the saturation
  strip on Load test vs app.

## 9. 409s on category attach under concurrent edits

- **Seen.** 20 × 409 on `POST /api/v1/private/product/{productId}/category/{categoryId}` (catalog) in the mix, from
  the `catalog-management` scenario's concurrent edits; also 21 × 409 at the gateway (`uri=UNKNOWN`, the relay of the
  same), 1 on tenancy signup, 1 on uaa users.
- **Known.** Optimistic locking doing its job under deliberately concurrent edits; the suite expects them. The rate
  is worth watching only if it rises without a concurrency change.
- **Where.** Service RED (catalog) → *409* stat and *Failed routes*.

## 10. Login and redirect paths on uaa and the gateway

- **Seen.** uaa p95: `UNKNOWN` 0.59 s, `REDIRECTION` 0.38 s (the authorization-code hops); gateway `REDIRECTION`
  0.53 s. Every API route on both is under 50 ms.
- **Known.** The `UNKNOWN` route on uaa is the token endpoint (Spring Authorization Server serves it from a
  filter, so Micrometer has no route for it); its cost and fix are issue 6. The two-hop sign-in (gateway → uaa →
  gateway) is expected to be the slowest thing on these services; 0.5 s is within the 2.5 s login SLO. The
  `platform/gateway-login` script was not run today.
- **Still to measure.** `make platform-gateway-login PROFILE=load` while watching Auth → *Token endpoint p95* and
  *Gateway sign-in and session* (the in-memory session count is the capacity signal there).

## Not seen, worth stating

- No 5xx in any run. No database connection waited (pending 0), no timeouts. No GC pressure (pause share 0,
  heap-after-GC flat). No request-thread saturation (busy under 1 %). Outbox backlog 0, no FAILED records.

## Re-run after the fixes (2026-09-06, built storefront)

| run | test id | before | after |
| --- | --- | --- | --- |
| `storefront-browse` load | `browse-load-20260906T124154Z` | pages 4.7–5.0 s p95, catalog 21.3 SQL/request, edge failed 4.2 % | pages 73–91 ms, catalog 5.7 SQL/request, edge failed 0, 14,055 req, 0 failed |
| `shopper-guest-checkout` load | `guest-checkout-load-20260906T124807Z` | checkout 11.2 SQL/request | 5.7 SQL/request, 90 orders, checkout p95 86 ms, 0 failed |
| `mixed-production-mix` load | `production-mix-load-20260906T125109Z` | admin 2 % failed (403s), pages ~4.4 s | 3,918 req, 0 failed on every layer, 31 orders, pages under 0.1 s; 409s on category attach remain (expected) |
| `storefront-breakpoint` to 600 it/s | `breakpoint-breakpoint-20260906T125416Z` | knee not found at 552 app req/s | knee not found at 1,540 app req/s; CPU 71 % is the first limit |

The whole sequence was repeated on a fresh stack (`lcl stop --hard`, empty volumes, fixtures re-provisioned:
test ids `browse-load-20260906T133147Z`, `guest-checkout-load-20260906T133755Z`,
`production-mix-load-20260906T134058Z`, `breakpoint-breakpoint-20260906T134403Z`) with the same numbers; the ramp
dropped 57 iterations at ~1,200 k6 req/s, so the next ramp needs more pre-allocated VUs before it can find the knee.

## What running the images showed (the load stack, 2026-09-06)

The four runs were repeated against the containerised stack — every service as the image `bootBuildImage`
produces, one container each, 1 GB per container ([load-testing.md](load-testing.md), "The load stack"). The API
tier behaved exactly as on the host; the storefront did not, and two of the three findings below are about the
image rather than the code.

| run | test id | result |
| --- | --- | --- |
| smoke | `smoke-smoke-20260906T190111Z` | 308 requests, 0 failed, 2 orders |
| `storefront-browse` load | `browse-load-20260906T190309Z` | 9,288 requests, 0 failed; **pages 2.35–2.63 s p95** against 73–91 ms on the host — the emulated image, see B; `catalog:product` 7.4 ms |
| `shopper-guest-checkout` load | `guest-checkout-load-20260906T190928Z` | 90 orders, 0 failed, checkout 48 ms p95 |
| `mixed-production-mix` load | `production-mix-load-20260906T191234Z` | 3,869 requests, 0 failed on every layer, 31 orders |
| `storefront-breakpoint` to 600 it/s | `breakpoint-breakpoint-20260906T191542Z` | 288,358 requests, 0 failed, 0 dropped, product p95 6.0 ms, **1,530 app req/s**, catalog pool 20 %, threads 1 %, heap after GC 19 % |

### A. The storefront image had no telemetry at all — fixed

`landing-ui` was absent from the span metrics and from the service graph on the container stack, while every Java
service reported normally. Two silent gaps in `next build --output standalone`: the compiled instrumentation hook
is not copied into the output, and the server `require()`s exactly that path and swallows `MODULE_NOT_FOUND`;
and Next keeps every `@opentelemetry` package except `api` external without bundling it, while file tracing does
not follow the dynamic `import('./src/shell/telemetry')` in `instrumentation.ts`. A deployed storefront therefore
produced no page-render spans, no upstream fetch spans and no service-graph entry — and said nothing about it.
`storefront/scripts/copy-instrumentation.mjs` (wired into `npm run build`) copies the hook with the chunks it
references and the telemetry dependency closure. Verified in the container: `✅ OpenTelemetry instrumentation
started`, page-render and `fetch GET /catalog/...` spans arriving, the `landing-ui → spg` edge back.

This is why issue 1 could only ever be measured on the host before: the image never traced.

### B. The two Node images are built for amd64 only — measured at 17× on the storefront

`store-pod/landing-ui` and `store-core/console-ui` are `linux/amd64` (their base is
`public.ecr.aws/b2i4h4k9/nodejs20`), while every buildpack-built Java image is `linux/arm64`. On an arm64 host the
two Node images run emulated. To separate emulation from the container limit and from everything else, the same
build was packaged onto a multi-arch Node 20 base, run with the same 1 GB limit on the same network, and given the
same `storefront-browse` load:

| storefront under `storefront-browse` at `PROFILE=load`, 30 VUs | `page:home` p95 | `page:product` p95 | `page:category` p95 |
| --- | --- | --- | --- |
| the shipped image, amd64 emulated, 1 GB (`browse-load-20260906T193538Z`) | 2.77 s | 2.60 s | 2.53 s |
| the same build on an arm64 base, 1 GB (`browse-load-20260906T195057Z`) | 157 ms | 118 ms | 141 ms |
| host process, `node start.mjs`, no container (`browse-load-20260906T124154Z`) | 91 ms | 73 ms | 79 ms |

Emulation costs about **17×** on this workload; the container itself costs about 1.7× against an unconstrained host
process, which is what a 1 GB limit and a shared CPU are expected to cost. A tight integer loop is only 2.4×
slower emulated (`node:20-alpine`, amd64 638 ms against arm64 261 ms), so the penalty is specific to what server
rendering does: V8 generating and running JIT code, which the emulator must translate as it is produced.

What follows: on an amd64 deployment target the shipped images run natively and none of this applies; on Graviton
they are the only two images that would be emulated, and their published architecture no longer matches the Java
images beside them. Publishing both for the deployment's architecture (or multi-arch) is the fix. It was left
alone because it changes what is published, and the numbers above are what the decision needs.

Local load runs on Apple Silicon are affected today: every storefront number taken against the container stack is
an emulated number, and the ones in this document say so.

### C. A Node 20 runtime error on the locale-redirect path — not fixed

`TypeError: controller[kState].transformAlgorithm is not a function`, 26 times in one browse run, always
immediately after `Locale 'en' not supported by store … Redirecting to … /ar`. It does not fail the request (0
failed in every run) but it is a real error on a real path. It appears on the arm64 rebuild too (7 times in 10
redirects), so it is the Node version rather than the architecture: the image runs Node 20.20.1, which Next 16
accepts, and this is a web-streams incompatibility fixed in Node 22. Moving the base image forward is the same
decision as B, and would settle both.

## What is still open

1. A ramp past 2,000 req/s, and the write-heavy scripts, to find the knee (issue 8).
2. `platform/gateway-login` at load for the sign-in path (issue 10).
3. Trace the s2s token client so the exchange stops showing as a gap on the edge (issue 6, observability only).
