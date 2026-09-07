# shellcheck shell=bash
# The gates CI runs (.github/workflows/check.yml), in order. `step "<name>" <command...>` stops at the first
# failure. Keep identical to CI.
#
# `npm test` = `npm run check`: npm audit, ESLint, Prettier, Markdownlint, ShellCheck, actionlint, `make inspect`
# (k6 parses every script, no traffic) and `make build` (one k6 archive per script for TARGET=lcl). k6 is required
# (`brew install k6`, CI pins 2.2.0); shellcheck and actionlint go through scripts/with-tool.sh — a warning
# locally when missing, a failure under CI=true.
command -v k6 >/dev/null 2>&1 || { echo "  ✘ k6 is not on PATH (brew install k6) — make inspect / make build need it" >&2; exit 1; }
step "install (npm ci)"                          npm ci
step "check (npm test: audit, lint stack, make inspect, make build)" npm test
step "diff is clean of whitespace errors"        git diff --check
