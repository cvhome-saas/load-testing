#!/usr/bin/env bash
# The load stack: the platform as its built images plus infra and monitoring, from stack/docker-compose.yml, every
# platform container held to the CPU and memory its Fargate task gets on AWS. Images are a pre-step (`./gradlew
# bootBuildImage` in cvhome, or LOAD_REGISTRY/LOAD_TAG from a registry); this script never builds.
#
#   stack/stack.sh up               resolve the sizes, compose up -d, wait until every Java service answers /actuator/health
#   stack/stack.sh down [--hard]    stop; --hard also removes the volumes (fresh database next time)
#   stack/stack.sh sizes            the CPU and memory each service would get under the knobs below, without starting
#   stack/stack.sh limits           what docker applied to each running container
#   stack/stack.sh ps | logs [svc]  what is running / its logs
#   stack/stack.sh stats            memory and CPU per container, once
#   stack/stack.sh hosts            the /etc/hosts lines a browser on this machine needs
#
# Knobs (environment):
#   LOAD_FLAVOUR=dev       the AWS shape: dev | staging | prod | ephemeral, the flavours of cvhome-platform's flavours.yaml
#                          (copied to stack/fargate-sizes.json), or off: no CPU cap and LOAD_MEM for every container
#   LOAD_CPU_FACTOR=0.45   cores here per Fargate vCPU, applied to every CPU cap. Measured on 2026-09-14 under dev's own
#                          load shape (storefront-browse, 30 shoppers): landing-ui spent 42 ms of CPU a page here and
#                          88-95 ms on dev (0.5 vCPU at 90-96 %, browse-load-20260913T214244Z); 42 / 93 = 0.45, and at
#                          0.45 the capped run pinned landing-ui as dev did (calib-0.45-browse-load-20260914T010001Z).
#   LOAD_MEM=              one memory limit for every platform and infra container, over the flavour's sizes
#   LOAD_POOL_SIZE=        Hikari maximum pool per JVM; default the flavour's rds.db_pool_size (dev 3), 10 when off
#   LOAD_TAG=latest        the platform images' tag; LOAD_TAG_<SERVICE> (LOAD_TAG_LANDING_UI=…) for one service apart
#   LOAD_REGISTRY=  OTEL_SDK_DISABLED=false  LOAD_WAIT=900 (seconds; a JVM on a quarter core starts slowly)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose=(docker compose -p cvhome-load -f "$here/docker-compose.yml")

java_services=(uaa store-core-gateway tenancy billing pod-registry merchant content catalog checkout cua payment inventory)
# Every container that gets a cap; the monitoring containers are left out on purpose.
capped_services=(postgres minio spg "${java_services[@]}" console-ui landing-ui)
# A function, not an associative array: macOS ships bash 3.2.
port_of() {
  case "$1" in
    uaa) echo 8001 ;; store-core-gateway) echo 8000 ;; tenancy) echo 8020 ;; billing) echo 8021 ;; pod-registry) echo 8022 ;;
    merchant) echo 8120 ;; content) echo 8121 ;; catalog) echo 8122 ;; checkout) echo 8123 ;; cua) echo 8124 ;;
    payment) echo 8125 ;; inventory) echo 8126 ;; landing-ui) echo 8110 ;; console-ui) echo 8011 ;; spg) echo 80 ;;
  esac
}

# LOAD_FLAVOUR, LOAD_CPU_FACTOR and LOAD_MEM against fargate-sizes.json: `export` lines on stdout (for eval), the table
# it applied on stderr. A service the flavour does not size (minio) keeps no CPU cap and LOAD_MEM.
resolve_sizes() {
  python3 - "$here/fargate-sizes.json" "${capped_services[@]}" <<'PY'
import json, os, sys
file, services = sys.argv[1], sys.argv[2:]
flavours = json.load(open(file))['flavours']
flavour = os.environ.get('LOAD_FLAVOUR') or 'dev'
factor_raw = os.environ.get('LOAD_CPU_FACTOR') or '0.45'
mem_override = os.environ.get('LOAD_MEM') or ''
pool = os.environ.get('LOAD_POOL_SIZE') or ''
if flavour != 'off' and flavour not in flavours:
    sys.exit(f"!! LOAD_FLAVOUR={flavour}: one of {' | '.join(sorted(flavours))} | off")
try:
    factor = float(factor_raw)
    assert factor > 0
except (ValueError, AssertionError):
    sys.exit(f'!! LOAD_CPU_FACTOR={factor_raw}: a positive number (cores here per Fargate vCPU)')
sizes = {} if flavour == 'off' else flavours[flavour]['services']
if not pool:
    pool = str(flavours[flavour]['dbPoolSize']) if flavour != 'off' else '10'
num = lambda v: ('%.4f' % v).rstrip('0').rstrip('.')
out = [f'export LOAD_FLAVOUR={flavour}', f'export LOAD_CPU_FACTOR={num(factor) if flavour != "off" else "1"}',
       f'export LOAD_POOL_SIZE={pool}']
rows = []
for name in services:
    key = name.upper().replace('-', '_')
    size = sizes.get(name)
    cpus = num(size['cpu'] / 1024 * factor) if size else '0'
    mem = mem_override or (f"{size['memory']}m" if size else '1g')
    out += [f'export LOAD_CPUS_{key}={cpus}', f'export LOAD_MEM_{key}={mem}']
    aws = f"{num(size['cpu'] / 1024)} vCPU {size['memory']} MiB" if size else '-'
    rows.append((name, size['size'] if size else '-', aws, f'{cpus} cpus' if cpus != '0' else 'no cpu cap', mem))
shape = f'LOAD_FLAVOUR={flavour}' + (f'  LOAD_CPU_FACTOR={num(factor)}' if flavour != 'off' else '  (today\'s uncapped stack)')
err = [f'==> {shape}  LOAD_POOL_SIZE={pool}' + (f'  LOAD_MEM={mem_override} over every size' if mem_override else '')]
err.append(f"    {'service':20s} {'size':13s} {'on AWS':20s} {'here':14s} memory")
err += [f'    {r[0]:20s} {r[1]:13s} {r[2]:20s} {r[3]:14s} {r[4]}' for r in rows]
err.append('    otel-collector loki tempo prometheus grafana: uncapped')
print('\n'.join(out))
print('\n'.join(err), file=sys.stderr)
PY
}

wait_healthy() {
  local deadline=$((SECONDS + ${LOAD_WAIT:-900})) pending
  while :; do
    pending=()
    for s in "${java_services[@]}"; do
      curl -sf "http://localhost:$(port_of "$s")/actuator/health" 2>/dev/null | grep -q '"status":"UP"' || pending+=("$s")
    done
    if [ ${#pending[@]} -eq 0 ]; then echo "==> every Java service is UP"; return 0; fi
    if [ $SECONDS -ge $deadline ]; then echo "!! still not UP after ${LOAD_WAIT:-900}s: ${pending[*]}" >&2; return 1; fi
    printf '    waiting for %s\n' "${pending[*]}"
    sleep 10
  done
}

# What docker applied, per running container of this project: CPU cap in cores, memory limit, and the shape labels.
applied_limits() {
  local ids
  ids="$("${compose[@]}" ps -q)"
  [ -n "$ids" ] || { echo "!! the load stack is not running" >&2; return 1; }
  printf '    %-20s %-12s %-10s %s\n' service cpus memory shape
  # shellcheck disable=SC2086 # one id per word
  docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}} {{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{with index .Config.Labels "cvhome.load.flavour"}}{{.}}/{{end}}{{with index .Config.Labels "cvhome.load.cpu-factor"}}{{.}}{{else}}-{{end}}' $ids \
    | awk '{ cpus = $2 > 0 ? sprintf("%g", $2 / 1e9) : "uncapped"; mem = $3 > 0 ? sprintf("%dm", $3 / 1048576) : "uncapped";
             printf "    %-20s %-12s %-10s %s\n", $1, cpus, mem, $4 }' | sort
}

case "${1:-}" in
  up)
    # The stack takes the platform's canonical ports; anything else on 8000 is in the way (an lcl dev stack, say).
    # grep reads to the end (no -q): an early exit would SIGPIPE compose and, under pipefail, read as "not this stack".
    if curl -sf -o /dev/null --max-time 2 http://localhost:8000/actuator/health 2>/dev/null && ! "${compose[@]}" ps --status running --services 2>/dev/null | grep -x store-core-gateway >/dev/null; then
      echo "!! something already answers on :8000 and it is not this stack; stop it first (lcl stop in cvhome?)" >&2; exit 1
    fi
    sizes="$(resolve_sizes)"; eval "$sizes"
    "${compose[@]}" up -d
    wait_healthy
    for s in landing-ui console-ui spg; do
      curl -s -o /dev/null -w "    $s %{http_code}\n" "http://localhost:$(port_of "$s")/" || true
    done
    echo "==> applied (docker inspect):"; applied_limits
    echo "==> http://gateway.com:8000  http://org1-store1.spg-507f1f77.gateway.com  http://localhost:3000 (Grafana)"
    ;;
  sizes)
    resolve_sizes >/dev/null
    ;;
  limits)
    applied_limits
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
    sed -n '2,24p' "$0"; exit 2
    ;;
esac
