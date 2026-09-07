#!/usr/bin/env bash
# The load stack: the platform as its built images plus infra and monitoring, from stack/docker-compose.yml.
# Images are a pre-step (`./gradlew bootBuildImage` in cvhome, or LOAD_REGISTRY/LOAD_TAG from a registry);
# this script never builds.
#
#   stack/stack.sh up               compose up -d, then wait until every Java service answers /actuator/health
#   stack/stack.sh down [--hard]    stop; --hard also removes the volumes (fresh database next time)
#   stack/stack.sh ps | logs [svc]  what is running / its logs
#   stack/stack.sh stats            memory and CPU per container, once
#   stack/stack.sh hosts            the /etc/hosts lines a browser on this machine needs
#
# Knobs (environment): LOAD_MEM=1g  LOAD_POOL_SIZE=10  LOAD_TAG=latest  LOAD_REGISTRY=  OTEL_SDK_DISABLED=false  LOAD_WAIT=600
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose=(docker compose -p cvhome-load -f "$here/docker-compose.yml")

java_services=(uaa store-core-gateway tenancy billing pod-registry merchant content catalog checkout cua payment inventory)
# A function, not an associative array: macOS ships bash 3.2.
port_of() {
  case "$1" in
    uaa) echo 8001 ;; store-core-gateway) echo 8000 ;; tenancy) echo 8020 ;; billing) echo 8021 ;; pod-registry) echo 8022 ;;
    merchant) echo 8120 ;; content) echo 8121 ;; catalog) echo 8122 ;; checkout) echo 8123 ;; cua) echo 8124 ;;
    payment) echo 8125 ;; inventory) echo 8126 ;; landing-ui) echo 8110 ;; console-ui) echo 8011 ;; spg) echo 80 ;;
  esac
}

wait_healthy() {
  local deadline=$((SECONDS + ${LOAD_WAIT:-600})) pending
  while :; do
    pending=()
    for s in "${java_services[@]}"; do
      curl -sf "http://localhost:$(port_of "$s")/actuator/health" 2>/dev/null | grep -q '"status":"UP"' || pending+=("$s")
    done
    if [ ${#pending[@]} -eq 0 ]; then echo "==> every Java service is UP"; return 0; fi
    if [ $SECONDS -ge $deadline ]; then echo "!! still not UP after ${LOAD_WAIT:-600}s: ${pending[*]}" >&2; return 1; fi
    printf '    waiting for %s\n' "${pending[*]}"
    sleep 10
  done
}

case "${1:-}" in
  up)
    # The stack takes the platform's canonical ports; anything else on 8000 is in the way (an lcl dev stack, say).
    if curl -sf -o /dev/null --max-time 2 http://localhost:8000/actuator/health 2>/dev/null && ! "${compose[@]}" ps --status running 2>/dev/null | grep -q store-core-gateway; then
      echo "!! something already answers on :8000 and it is not this stack; stop it first (lcl stop in cvhome?)" >&2; exit 1
    fi
    "${compose[@]}" up -d
    wait_healthy
    for s in landing-ui console-ui spg; do
      curl -s -o /dev/null -w "    $s %{http_code}\n" "http://localhost:$(port_of "$s")/" || true
    done
    echo "==> http://gateway.com:8000  http://org1-store1.spg-507f1f77.gateway.com  http://localhost:3000 (Grafana)"
    ;;
  down)
    if [ "${2:-}" = "--hard" ]; then "${compose[@]}" down -v; else "${compose[@]}" down; fi
    ;;
  ps)
    "${compose[@]}" ps
    ;;
  logs)
    shift; "${compose[@]}" logs --tail=200 "$@"
    ;;
  stats)
    docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.CPUPerc}}' | grep -E 'NAME|cvhome-load' | sed 's/cvhome-load-//'
    ;;
  hosts)
    for h in gateway.com www.gateway.com uaa.gateway.com console-ui.gateway.com spg-507f1f77.gateway.com spg-org3.gateway.com \
             org1-store1.spg-507f1f77.gateway.com org1-store2.spg-507f1f77.gateway.com org2-store1.spg-507f1f77.gateway.com \
             org2-store2.spg-507f1f77.gateway.com org3-store1.spg-507f1f77.gateway.com; do
      echo "127.0.0.1 $h"
    done
    ;;
  *)
    sed -n '2,13p' "$0"; exit 2
    ;;
esac
