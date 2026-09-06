# cvhome load testing

k6 tests for **cvhome**, the multi-tenant e-commerce SaaS in `../cvhome`, deployed by `../cvhome-platform`.
The suite drives every layer the platform has an audience for — the storefront in a real browser, the shopper
APIs, the seller and platform consoles' APIs, and the edges in between — and is built to find where each one
breaks: connection pools, request threads, caches, rate limiters, row locks.

## The platform in one picture

```text
shopper ──► spg (Caddy, one per pod) ──► landing-ui (Next.js SSR)      http://<store>.spg-<pod>.<domain>/en
             │                        ├─► catalog   /catalog/api/…      products, categories, search
             │                        ├─► inventory /inventory/api/…    price + stock by sku
             │                        ├─► merchant  /merchant/api/…     the store, host → store lookup
             │                        ├─► content   /content/api/…      layout, menus, pages, posts
             │                        ├─► checkout  /checkout/api/…     carts, orders
             │                        ├─► payment   /payment/api/…      payment types
             │                        └─► cua       /cua/…              shopper identity (PKCE)
seller ───► store-core-gateway (OAuth2 client of uaa, in-memory sessions)   http://<domain>:8000
             ├─► /uaa/**            staff identity, admin API
             ├─► /tenancy /billing /pod-registry
             └─► /spg/<service>/…?store=&pod=   token relay into the pod that hosts the store
```

Orgs own stores; stores live on pods. Every API call carries `?store=<id>&lang=<code>`; seller calls into a pod
also carry `&pod=<id>` or the gateway has no route. A store's storefront host is its name under the pod domain.

## Quick start

```bash
brew install k6                                          # validated with k6 v2.2.0
cd ../cvhome && lcl start -d --infra all && cd -         # the local stack, with Prometheus/Grafana/Tempo
make preflight                                           # is everything answering?
make selftest                                            # every client method once, against the target
make smoke                                               # every journey once; provisions the k6-local fixture store
make storefront-browse PROFILE=load PEAK_VUS=50
make shopper-guest-checkout PROFILE=load RATE=60 DURATION=10m
make mixed-production-mix PROFILE=load
make help                                                # every target and every knob
```

Everything goes through `bin/k6run`, which adds the `testid`/`layer`/`target` tags, streams samples to
Prometheus and writes `results/<testid>.json`. `NO_PROM=1` keeps a run local.

`lcl start` gives development numbers: every service is `gradle bootRun` on the host with no memory limit, and
the storefront is `next dev`. For numbers that say something about a deployment, run the platform as its images,
one container per service, 1 GB each — the same ports and hostnames, so `TARGET=lcl` stays as it is:

```bash
cd ../cvhome && lcl stop && extra/scripts/load-stack.sh build && extra/scripts/load-stack.sh up && cd -
make smoke                                               # then any run above
cd ../cvhome && extra/scripts/load-stack.sh stats        # memory and CPU per container during a run
```

What that stack is and what still differs from a deployment: `cvhome/extra/monitoring/docs/load-testing.md`,
section "The load stack".

## GitHub Actions

`Check` runs for pull requests, pushes to `main`, and manual dispatches. It checks the shell and JSON files,
audits the locked npm packages, runs ESLint, Prettier, Markdownlint, ShellCheck, and actionlint, resolves every
k6 import with `make inspect`, and builds an archive for every test script. An archive bakes in the deployment
file it was built for (`make build TARGET=<name>` writes `build/k6/<name>/…`; run one with
`k6 run -e TARGET=<name> <archive>`) because `k6 archive` reads no shell environment at init. Use the same complete
gate locally with `npm ci && npm test`; formatting fixes are available through `npm run format` and
`npm run lint:fix`. `shellcheck` and `actionlint` are optional locally (`brew install shellcheck actionlint` on
macOS): when a binary is missing the check prints a warning and passes; under `CI=true` it fails. CI installs
checksum-pinned official binaries. Node 20.19 or newer (CI uses Node 24).

`Run k6 tests` is manual-only. Choose `selftest`, `smoke`, or `all-smoke` from the Actions page. The workflow
reads these optional GitHub Actions variables and secrets; an unset or empty value falls back to the selected
`k6/config/env/<TARGET>.json` file or the default declared in `k6/lib/core/env.js`:

| Actions value | Kind | Fallback |
| --- | --- | --- |
| `GATEWAY_URL`, `UAA_URL`, `POD_DOMAIN`, `POD_ID` | variable | selected target file |
| `PROMETHEUS_URL` | variable | selected target file; only used when **Publish metrics** is enabled |
| `K6_RUNNER` | variable | `ubuntu-latest`; use a self-hosted runner label for private/local URLs |
| `SELLER_PASSWORD`, `SHOPPER_PASSWORD` | secret | selected target file |
| `FIXTURE_PASSWORD` | secret | `K6-load-test-1` |

## How it is built

```text
k6/config/env/<target>.json    a deployment: hosts, pod, seeded stores and accounts (lcl.json is committed; copy aws.example.json for the rest)
k6/config/thresholds.js        the only place SLO numbers live — sloFor(layer, profile)
k6/config/profiles.js          load shapes by PROFILE: scenario('vus'|'rate'|'once', exec, knobs), browserScenario(), build()
k6/config/mix.js               the traffic ratios of the production mix
k6/lib/core/                   env (the declared __ENV schema), edges, http (one request function), tags, metrics, session, pkce, wait
k6/lib/clients/                one class per backend service, one method per endpoint, edge-agnostic
k6/lib/journeys/<layer>/       what a user does: shopper, admin, platform, browser (page objects under browser/pages)
k6/lib/fixtures/               provision() the k6-<RUN_ID> org/store/catalogue/shoppers/sessions; cleanup
k6/data/                       the seeded demo catalogue, small generators
k6/scripts/<layer>/            10–20 line scripts: a profile, a journey, the fixtures it needs
docs/coverage.md               endpoint family → client method → script
docs/prometheus.md             labels, queries, the application signals to watch next to them
scripts/                       preflight, cleanup (API pass, then SQL)
```

Imports go one way: `core` ← `clients` ← `journeys` ← `scripts`. A client is constructed with an **edge**
(`storefrontEdge(store)`, `sellerEdge(session, store)`, `platformEdge(session)`, `uaaEdge()`) that owns the base
URL, the mandatory query parameters, the auth headers and the `layer` tag, so the same `CatalogClient` reads the
storefront through spg or the console through the gateway. Every call returns `{ res, ok, status, body }`, never
throws on a status, and carries a stable `name` tag per endpoint.

Adding an endpoint is one method in a client. Adding a service is one file in `clients/`. Adding a load test is one
script that picks a journey and a profile.

## Scripts

`make <layer>-<name>`; every one honours `PROFILE`, `TARGET`, `RUN_ID` and the knobs in `make knobs`.

| layer | script | model | what it exercises | writes |
| --- | --- | --- | --- | --- |
| storefront | browse | closed (PEAK_VUS) | SSR home/category/product + the API reads behind them, some search | — |
| storefront | search | open (RATE) | suggest, full-text with facets, sorted pages | — |
| storefront | content | open | site, menus, banners, policies, faq, posts, layout | — |
| storefront | breakpoint | ramping rate to MAX_RPS | product + availability until an SLO breaks, then aborts | — |
| storefront | soak | constant VUs for DURATION | the browse journey for hours: leaks, pools, caches | — |
| shopper | cart | open | cart create / add / read / change / remove | carts |
| shopper | guest-checkout | open | cart → checkout page reads → COD or MANUAL_TRANSFER order → status | orders |
| shopper | account | open, low | PKCE sign-in, purchase with the token, my orders | orders |
| shopper | registration | open | cua registration bursts | shoppers |
| shopper | inventory-contention | open, high | everyone buys the same sku: row locks on reserve | orders |
| admin | store-reads | closed | store list/detail/info, billing state, themes | — |
| admin | store-lifecycle | open, low | signup → sign-in → create → provisioned → update → suspend → resume → archive → delete | orgs, stores |
| admin | catalog-management | open | category, product, price/stock, inline toggle, listing, delete | products |
| admin | content-management | open | pages, and the HOME layout's optimistic versioning under concurrency | pages |
| admin | orders-list | closed | the orders screen, filters, one order, payment ledger | — |
| admin | platform-reads | closed | pods, users, roles, plans, subscriptions, statistics | — |
| platform | gateway-login | open, ≤ limiter | the two-hop sign-in; in-memory session growth | sessions |
| platform | spg-domain-lookup | open | known and unknown storefront hosts through spg's domain cache | — |
| platform | uaa-public | open | sign-in settings, idps, jwks, discovery, cua authorize | — |
| platform | rate-limit-probe | fixed | pushes a public POST past its window: 429, never 5xx | — |
| browser | shopper-checkout | 3–5 Chromium + HTTP background | home → … → "Order placed", Web Vitals | orders |
| browser | shopper-auth | Chromium | register and sign in through cua's hand-off pages | shoppers |
| browser | browse | Chromium | home, search, category, product: LCP / CLS / INP | — |
| mixed | production-mix | seven scenarios at once | a normal day, ratios in `k6/config/mix.js` | yes |

Profiles: `smoke` (1 iteration), `load`, `stress` (2–3×), `spike` (10× for a minute), `soak` (DURATION),
`breakpoint` (ramping rate, thresholds abort). Thresholds are per layer in `k6/config/thresholds.js`; the starting
numbers are for the local stack and should be tightened per target once a baseline exists.

## Fixtures and data

Write-side scripts declare `needs: ['store', 'catalog', 'sessions', 'shoppers']` and `setup()` provisions the
exact `k6-<RUN_ID>` org and store through the public signup and the console API, waits for the pod to provision it, and
fills it with `FIXTURE_PRODUCTS` products carrying `FIXTURE_STOCK` units each. `RUN_ID` defaults to `local`, so the
same store is found and reused run after run; `RUN_ID=fresh` makes a new one. The seeded demo stores are only ever
read (except carts and shopper registrations). `make clean` removes everything named `k6-` (API pass, then
`scripts/cleanup.sql` through the postgres container).

Fixture store names never gain an automatic suffix: `RUN_ID=local` creates only `k6-local`, so the host is
predictable. k6 resolves it without any system change: HTTP requests through `options.hosts` from the deployment
file, Chromium through the same wildcard that `bin/k6run` passes in `K6_BROWSER_ARGS`. Add
`127.0.0.1 k6-local.spg-507f1f77.gateway.com` to `../cvhome/extra/scripts/configure-domain.sh` only for your own
browser and `curl`.

`KEEP_FIXTURES=false` archives and deletes the store in `teardown()`, and a deleted store keeps its name, so the
next run with the same `RUN_ID` stops until `make clean` has run its SQL pass (the API pass alone soft-deletes
and leaves the name reserved).

## Metrics

Every sample carries `testid`, `layer`, `target`, `profile`, `name` (per endpoint) and `store`; `url` is
deliberately dropped. Every time-typed trend (k6's built-ins and the suite's `*_ms` ones alike) arrives in **seconds** through remote
write; the `_ms` names describe the local summary, not the Prometheus unit. Custom metrics: `journey_duration_ms{journey}`, `journey_errors{journey}`,
`unexpected_status{name,status}`, `rate_limited`, `orders_placed`, `stores_created`, `products_created`,
`shoppers_registered`, `shopper_auth_ms`, `seller_login_ms`, `seller_session_lost`, `fixture_provision_ms`,
`domain_lookups{known}`, `browser_errors`. Queries and the application-side signals to correlate with are in
`docs/prometheus.md`.

## Prerequisites on the application side (not done here)

| change | where in `../cvhome` | why |
| --- | --- | --- |
| `lcl start -d --infra all` | — | Prometheus with the remote-write receiver, Grafana, the collector, Tempo |
| add `127.0.0.1 k6-local.spg-507f1f77.gateway.com` | `extra/scripts/configure-domain.sh` | only for a human's browser and `curl`; k6 and its Chromium resolve it themselves |
| start the stack with `OTEL_SDK_DISABLED=false` | — | otherwise Prometheus holds k6's metrics and none of the application's |
| Hikari stays 5/1 for the first runs, then 10 | `lcl-config.yml` | comparability with the Fargate default |

JVM metrics, Tomcat thread metrics, latency histograms, the SLI recording rules and the provisioned dashboards are in
`../cvhome` (`extra/monitoring/`); `docs/prometheus.md` says how a run appears there and `make dash` opens it.

## Known limits

- The local stack runs the storefront on `next dev` and the console on the Angular dev server: SSR and browser
  numbers are dev-server bound. API numbers are one JVM per service on one machine and a single postgres.
- A store created through the console answers 409 on its storefront `site` document until
  [cvhome #324](https://github.com/cvhome-saas/cvhome/pull/324) lands; the home page still renders (it reads the
  layout), so only the `content:site` call of the content journey is affected on the fixture store.
- A trial store allows 25 products (fixtures provision 20 to leave room for the catalogue-edit journey, and count a
  422 at the cap as `plan_limit_hits`) and 50 orders a month; a long checkout run on the fixture store will meet
  that cap. It also refuses shopper self-registration, so registration and account tests use the seeded stores.
- One writable store per org: the trial goes to the first store, later ones are blocked (402 on every write), and
  a deleted store keeps its name. Fixtures fail instead of inventing an unconfigured hostname when the exact
  `k6-<RUN_ID>` store cannot be reused; `make clean` resets it.
- The rate limiter is 1000/min under the `test-stores` profile locally; deployed targets keep 10/60/20 per minute,
  which `rateLimitProfile` in the deployment file switches the login-heavy scripts to.
- The gateway keeps sessions in memory: restarting it invalidates every seller session; `setup()` logs in again on
  the next run.
- org1-store1 requires a signed-in shopper to place an order (`shopper/account` covers it); the fixture store does not.
- Product photos 404 locally (MinIO has no volume); `BROWSER_BLOCK_IMAGES=1` keeps them out of browser failure rates.
