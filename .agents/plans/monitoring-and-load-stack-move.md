# Move the load stack and the monitoring configuration into load-testing

## Context

cvhome carried both the platform's monitoring configuration (`extra/monitoring/`: collector, Prometheus rules,
Loki, Tempo, Grafana provisioning and twelve dashboards, docs, a CI job) and the load stack
(`docker-compose-load.yml` as an overlay on `docker-compose-lcl.yml`, `extra/scripts/load-stack.sh`). The suite
that reads the dashboards and drives the stack lives here, and its docs said `lcl start`, which gives
development numbers and no application telemetry unless a flag is remembered. Two repos described one
operation differently; the orchestrator followed the wrong one (2026-09-07 run
`production-mix-load-20260907T215313Z`).

## Why the design is what it is

- **One owner for "reading the platform".** Everything that observes the platform sits beside what drives it:
  `stack/` (compose, script) and `stack/monitoring/` (configs, dashboards, generators), `docs/monitoring/`.
  cvhome keeps only what the application itself emits (`common-config.yml` otel block, metrics it exposes).
- **Standalone compose, no overlay.** `stack/docker-compose.yml` needs nothing from the cvhome checkout: spg is
  the app's own built image (Caddyfile baked in), infra and monitoring are inline. The only inputs are images.
- **Images are a pre-step.** The stack never builds: `./gradlew bootBuildImage` in cvhome, or
  `LOAD_REGISTRY`/`LOAD_TAG` from a registry. A released version is `LOAD_TAG=2.0.0`.
- **Telemetry on by default.** `OTEL_SDK_DISABLED=false` is the compose default; a load stack without telemetry
  has nothing to read.
- **Target `local`, not `lcl`.** The suite no longer assumes the lcl runner; the name says where, not with what.

## Phase 1 — load-testing (PR 1)

`stack/docker-compose.yml`, `stack/stack.sh` (up/down/ps/logs/stats/hosts), `stack/monitoring/**` (moved from
cvhome, paths fixed, `otel-collector.yml` renamed), `docs/monitoring/**`, Makefile targets (`stack-*`, `hosts`,
`monitoring-check`), CI job `monitoring`, `verify.steps.sh`, `TARGET=local` (`k6/config/env/local.json`), README,
AGENTS, QA cases 05.x. Verified by starting the stack on existing images, `make preflight`, `make smoke`.

## Phase 2 — cvhome (PR 2, orchestrator `cross-repo-change`)

Delete `extra/monitoring/`, `docker-compose-load.yml`, `extra/scripts/load-stack.sh`; drop the five monitoring
services from `docker-compose-lcl.yml` and the otel-collector ports/endpoints from `lcl.yml`; remove the
`monitoring` CI job; repoint `AGENTS.md`, the project-structure references (`build-system.md`, `qa-testing.md`,
`gateways-and-local-domains.md`) and `qa/lcl-qa.md` at this repo. The application's own otel configuration stays.

## Phase 3 — orchestrator

`tools-task` (how to run a load test: `make stack-up` here, images are the person's pre-step), `qa.md`, the
repo map and contract table (local collector config and dashboards now here), `impact.py` rules, known-drift.

## Deviations, as built

- Phase 1: `spg` is the app's own built image (`store-pod/spg`), not the saas-gateway image + a mounted Caddyfile, so the compose has no cvhome path in it. Grafana's home dashboard path is the real file name (`cvhome-platform-overview.json`). `TARGET=local` replaces `lcl` everywhere in the suite.

## Verification

- Phase 1: `docker compose config -q`; `make stack-up` on the images present locally; `make preflight`;
  `make smoke`; `make monitoring-check`; `scripts/verify.sh`.
