#!/usr/bin/env bash
# Is the target ready for a run? Exit 1 on the first hard failure; warnings do not fail.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${TARGET:-lcl}"
envfile="$root/k6/config/env/$TARGET.json"
[ -f "$envfile" ] || { echo "✗ $envfile missing"; exit 1; }
read -r gateway uaa pod store storeid prom < <(python3 - "$envfile" <<'PY'
import json,sys
e=json.load(open(sys.argv[1])); s=e['stores'][0]
print(e['gatewayUrl'], e['uaaUrl'], e['podDomain'], s.get('url') or f"http://{s['name']}.{e['podDomain']}", s['id'], e.get('prometheusUrl',''))
PY
)
ok=0
probe() { # label url expected
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$2")
  if [ "$code" = "$3" ]; then echo "✓ $1 ($code)"; else echo "✗ $1 -> $code (want $3)  $2"; ok=1; fi
}
probe "gateway console" "$gateway/" 200
probe "gateway health" "$gateway/actuator/health" 200
probe "uaa public login settings" "$uaa/api/v1/public/login/settings" 200
probe "storefront home" "$store/en" 200
probe "catalog through spg" "$store/catalog/api/v1/category-hierarchy?count=1&page=0&store=$storeid&lang=en" 200
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 --resolve "k6-preflight.$pod:80:127.0.0.1" "http://k6-preflight.$pod/en")
case "$code" in 404|307) echo "✓ spg refuses an unknown sub-domain ($code)";; *) echo "! spg unknown sub-domain -> $code (want 404 or 307; only meaningful on lcl)";; esac
if [ -n "$prom" ]; then
  base="${prom%/api/v1/write}"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$base/-/ready")
  [ "$code" = "200" ] && echo "✓ prometheus ready ($base)" || echo "! prometheus not reachable at $base — run lcl start -d --infra all, or NO_PROM=1"
fi
if command -v k6 >/dev/null; then
  echo "✓ $(k6 version | head -1)"
else
  echo "✗ k6 not installed"
  ok=1
fi
exit $ok
