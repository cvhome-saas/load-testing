#!/usr/bin/env bash
# Runs a checker only when it is installed: a warning locally, a failure under CI=true (GitHub sets it).
#   scripts/with-tool.sh shellcheck bin/k6run scripts/*.sh
set -uo pipefail
tool="${1:?usage: with-tool.sh <tool> [args...]}"
shift
if command -v "$tool" >/dev/null 2>&1; then
  exec "$tool" "$@"
fi
if [ "${CI:-}" = "true" ]; then
  echo "✗ $tool is required in CI and is not on PATH" >&2
  exit 1
fi
echo "! $tool not installed; skipping (brew install $tool)" >&2
