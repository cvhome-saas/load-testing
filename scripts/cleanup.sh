#!/usr/bin/env bash
# 1. API pass: archive + delete every k6- store the way a seller would.
# 2. SQL pass: rows no API deletes (orders, carts, shoppers, orgs), through the lcl postgres container.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root" || exit
NO_PROM=1 bin/k6run k6/scripts/cleanup.js || echo "! API pass failed (stack down?) — continuing with SQL"
container="${PG_CONTAINER:-$(docker ps --format '{{.Names}}' | grep -E 'postgres' | head -1)}"
if [ -z "$container" ]; then echo "! no postgres container found; skip SQL pass"; exit 0; fi
echo "SQL pass via $container"
docker exec -i "$container" psql -U "${PG_USER:-postgres}" -d "${PG_DB:-cvhome}" < scripts/cleanup.sql
