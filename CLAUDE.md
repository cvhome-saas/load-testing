# load-testing

k6 load, stress, soak, breakpoint and browser tests for **cvhome**. Sibling repos:

| repo | what | read first |
|---|---|---|
| `../cvhome` | the application: Spring Boot services, Angular console, Next.js storefront | `AGENTS.md`, `.claude/skills/project-structure/references/qa-testing.md`, every `<service>/http/*.http` |
| `../cvhome-platform` | its AWS infrastructure: Terraform, ECS Fargate, one CloudFormation bootstrap | `CLAUDE.md`, `services.yaml`, `flavours.yaml` |

`README.md` is the map of this repo; `docs/coverage.md` is the audit (every endpoint family → client method →
script); `docs/prometheus.md` is where the numbers go. The k6 skill in `.claude/skills/k6/` is the authoring guide
(examples, browser practices, validation rules).

## Architecture rules

- **Imports go one way**: `lib/core` ← `lib/clients` ← `lib/journeys` ← `scripts`. A script is a profile, a
  journey and the fixtures it needs — nothing else. HTTP only in clients; behaviour only in journeys.
- **One client per service, edge-agnostic.** A client takes an edge (`storefrontEdge`, `sellerEdge`,
  `platformEdge`, `gatewayEdge`, `uaaEdge` in `lib/core/edges.js`). Adding an endpoint is one method that calls
  `request()` from `lib/core/http.js` with a stable `name` tag (`service:endpoint`, never an id in it) and the
  statuses it expects. Never call `k6/http` directly outside `lib/core`.
- **Every knob is declared** in `lib/core/env.js` (`SCHEMA`): default, type, one-line doc. Scripts never read
  `__ENV`. Deployment facts live in `k6/config/env/<TARGET>.json`; only `lcl.json` is committed.
- **SLO numbers live in `k6/config/thresholds.js`**, load shapes in `k6/config/profiles.js`, traffic ratios in
  `k6/config/mix.js`. A script adds only journey-specific thresholds.
- **Fixtures are declared, not scripted**: `build({ needs: ['store','catalog','sessions','shoppers'] })` and
  `export const { setup, teardown } = withFixtures(options)`. Everything the suite creates is named `k6-…` and
  `make clean` removes it. The seeded demo stores are read-only for the suite (carts and registrations aside).
- **Tags stay low-cardinality**: `testid`, `layer`, `target`, `profile`, `name`, `store`, `journey`. Never a
  URL, an id or a per-VU value. `bin/k6run` drops the `url` system tag on purpose.
- **Line 1 of every `.js` is the generated-by comment** the k6 skill requires; files are kebab-case under
  `k6/scripts/<layer>/` and camelCase under `k6/lib/`.

## Working here

- Validate without traffic: `make inspect`. Validate against the stack: `make selftest` (every client method,
  `expect.soft`, one run reports every broken contract), then `PROFILE=smoke make <layer>-<name>`.
- The stack: `lcl start -d --infra all` in `../cvhome`; `lcl status`, `lcl why <service>`. Read live ports from
  `lcl urls` if a second stack shifted them. Never `kill` a supervised process.
- Facts that shaped the suite (verified against the app, keep them true): a store's storefront host is its name
  under the pod domain; store creation is asynchronous (poll `router/store-pod-by-store-id`); a trial store is
  capped at 25 products, has no payment configuration and refuses self-registration until configured; org1-store1
  requires a signed-in shopper at checkout and defaults to `ar`; `/spg/**` needs both `store` and `pod`; paging is
  `page`+`count`; search `sort` is upper-case (`RELEVANCE|NEWEST|OLDEST`), listing `sort` is a Pageable column
  (`dateAvailable,desc`); the rate limiter is 1000/min locally, 10/60/20 per minute deployed; gateway sessions are
  in memory.
- App-side changes (OTEL on, JVM metrics, un-dropping tomcat metrics, Hikari sizing) belong to `../cvhome`; flag
  them in the README's prerequisites table, do not make them here.
