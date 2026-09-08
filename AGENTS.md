# load-testing

k6 load, stress, soak, breakpoint and browser tests for **cvhome**. Sibling repos:

| repo | what | read first |
|---|---|---|
| `../cvhome` | the application: Spring Boot services, Angular console, Next.js storefront | `AGENTS.md`, `.claude/skills/project-structure/references/qa-testing.md`, every `<service>/http/*.http` |
| `../cvhome-platform` | its AWS infrastructure: Terraform, ECS Fargate, one CloudFormation bootstrap | `CLAUDE.md`, `services.yaml`, `flavours.yaml` |

`README.md` is the map of this repo; `docs/coverage.md` is the audit (every endpoint family → client method →
script); `docs/prometheus.md` is where the numbers go. `stack/` is the load stack (`docker-compose.yml`, `stack.sh`)
and `stack/monitoring/` the collector, Prometheus rules, Loki, Tempo and Grafana dashboards that read it;
`docs/monitoring/` explains them. This repo owns the platform's monitoring configuration; cvhome ships none. The k6 skill in `.claude/skills/k6/` is the authoring guide
(examples, browser practices, validation rules).

## Architecture rules

- **Imports go one way**: `lib/core` ← `lib/clients` ← `lib/journeys` ← `scripts`. A script is a profile, a
  journey and the fixtures it needs — nothing else. HTTP only in clients; behaviour only in journeys.
- **One client per service, edge-agnostic.** A client takes an edge (`storefrontEdge`, `sellerEdge`,
  `platformEdge`, `gatewayEdge`, `uaaEdge` in `lib/core/edges.js`). Adding an endpoint is one method that calls
  `request()` from `lib/core/http.js` with a stable `name` tag (`service:endpoint`, never an id in it) and the
  statuses it expects. Never call `k6/http` directly outside `lib/core`.
- **Every knob is declared** in `lib/core/env.js` (`SCHEMA`): default, type, one-line doc. Scripts never read
  `__ENV`. Deployment facts live in `k6/config/env/<TARGET>.json`; only `local.json` is committed.
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
- The stack: `make stack-up` — `stack/docker-compose.yml`, the platform's **prebuilt** images (`./gradlew
  bootBuildImage` in `../cvhome` is a pre-step, or `LOAD_REGISTRY`/`LOAD_TAG` from a registry; this repo never
  builds an image), one container per service at `LOAD_MEM`, plus infra and monitoring, telemetry on. `make
  stack-ps`, `make stack-logs S=<service>`, `make stack-stats`, `make stack-down[-hard]`. It takes the platform's
  canonical ports; an `lcl` dev stack in `../cvhome` must be stopped first, and numbers from a dev stack are never
  recorded as load numbers. Against a deployed target, `make aws-up` starts only the monitoring
  (`stack/docker-compose.aws.yml`, its own `cvhome-aws` project) and `TARGET=aws` points the suite at
  `k6/config/env/aws.json`; README → *Load testing a deployed environment*.
- Facts that shaped the suite (verified against the app, keep them true): a store's storefront host is its name
  under the pod domain; store creation is asynchronous (poll `router/store-pod-by-store-id`); a trial store is
  capped at 25 products, has no payment configuration and refuses self-registration until configured; org1-store1
  requires a signed-in shopper at checkout and defaults to `ar`; `/spg/**` needs both `store` and `pod`; paging is
  `page`+`count`; search `sort` is upper-case (`RELEVANCE|NEWEST|OLDEST`), listing `sort` is a Pageable column
  (`dateAvailable,desc`); the rate limiter is 1000/min locally, 10/60/20 per minute deployed; gateway sessions are
  in memory.
- App-side changes (which metrics a JVM emits, Hikari defaults, an endpoint's shape) belong to `../cvhome`; flag
  them in the README's prerequisites table, do not make them here. What the stack *does* with telemetry — the
  collector pipeline, recording rules, dashboards — is this repo's: change `stack/monitoring/` and run
  `node stack/monitoring/scripts/build-dashboards.mjs` + `dashboard-docs.mjs` so the JSON and `docs/monitoring/dashboards.md`
  follow the spec (`make monitoring-check` fails otherwise).

## Working conventions (org standard — the same in every cvhome-saas repo)

Part of the `cvhome-saas` organisation. Cross-repo routing, review and releases live in `cvhome-saas/orchestrator`;
this file is the repo's own rulebook, and the architecture rules above stay in force unchanged.

- **`main` is the integration branch — and, here, the release.** Every change lands by PR into `main`; nobody
  commits or pushes to `main` directly. load-testing is a rolling repo: there is no version file, no manual tag,
  and no `Release` step of its own — a run uses whatever `main` holds, and `Run k6 tests` builds from it. Where
  the org standard cuts `vX.Y.Z` tags with the orchestrator's `Release` workflow, this repo does not carry a
  product version at all.
- **Every change starts as a fresh worktree cut from up-to-date `main`, before the first file is written:**

  ```bash
  git fetch origin
  git worktree add --no-track .claude/worktrees/<type>-<short-name> -b <type>/<short-name> origin/main
  ```

  `<type>` ∈ `feat|fix|docs|chore|refactor|test`. Work, validate and verify from inside that worktree; the
  primary checkout stays clean on `main`. `.claude/hooks/worktree-guard.mjs` denies any edit in the primary
  checkout (`ALLOW_MAIN_WRITES=1` is the person's deliberate escape hatch, never the agent's).
- **A plan is phases; a phase is one PR.** Anything bigger than one PR starts as
  `.agents/plans/<kebab-name>.md` (template: `.agents/plans/README.md`): context, why the design is what it
  is, then `## Phase N — <area> (PR N)` sections each small enough to review in one sitting, then
  deviations as built and verification. One plan, one worktree, one branch; each phase is committed and
  shipped as its own PR before the next begins (stacked if it must). A plan that needs an app-side change
  (`../cvhome`) or an infra change (`../cvhome-platform`) names it and hands that phase to the orchestrator
  (`cross-repo-change`) — see *Working here*: those changes are flagged in the README's prerequisites table,
  never made here.
- **Nothing is pushed until the gates have passed locally.** `scripts/verify.sh` runs exactly what CI runs
  (`scripts/verify.steps.sh`: `npm ci`, then `npm test` = npm audit, ESLint, Prettier, Markdownlint, ShellCheck,
  actionlint, `make inspect`, `make build`, then `make monitoring-check` when docker is running) and writes a receipt for the exact tree; `.githooks/pre-push` and
  `.claude/hooks/push-guard.mjs` refuse a push without it, a push to `main`, and `--no-verify`. k6 must be
  installed; shellcheck and actionlint are optional locally (`scripts/with-tool.sh`) and required under `CI=true`.
- **`/go` ships the working tree** (commit → verify → push → PR into `main`, template filled, changelog
  label); **`/reset` returns to a clean `main`** without losing work. Both in `.claude/commands/`.
- **PR body follows `.github/PULL_REQUEST_TEMPLATE.md`**: *Why → What → The parts that are not obvious →
  Deviations → Verification*. Label it: `type/enhancement|bug|documentation|test|chore|dependency-upgrade`,
  `warn/api-change|behavior-change|deprecation|regression|blocker`, `ignore-changelog`.
  `.github/release.yml` turns labels into release notes for the org's changelog; a `warn/*` label here says the
  suite's contract with the app changed (a threshold, a knob, a fixture name).
- **QA is a file that travels with the code.** An operator-visible behaviour — a make target, a knob, where results
  and annotations land, what `make clean` removes — is not done until it has a case in `qa/load-testing-qa.md`
  (template: `qa/README.md`), tagged **[verified]** / **[not verified]**, with setup, steps and expected result.
  `make inspect` and `make selftest` prove the scripts and the clients; the QA file proves the path an operator
  takes.
- **No design gate here.** This repo has no screens; the org's design-portal rule does not apply.
- **Commit messages**: `<type|area>: <what changed>`, imperative, plus a body when the change is not
  self-evident, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Completion gates

- [ ] `scripts/verify.sh` green for the exact tree being pushed
- [ ] A new script has the generated-by comment on line 1, a `make <layer>-<name>` target (automatic from its
      path), a row in `README.md` → *Scripts*, and its endpoints in `docs/coverage.md`
- [ ] A new knob is declared in `lib/core/env.js` and shows in `make knobs`
- [ ] A dashboard change went through `dashboards.spec.mjs` and both generators; `make monitoring-check` green
- [ ] Operator-visible behaviour has a case in `qa/load-testing-qa.md`, tagged honestly
- [ ] Anything `../cvhome` or `../cvhome-platform` must change is named in the PR body under *Deviations*
