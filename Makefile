# cvhome load tests. Every target honours TARGET (lcl|dev|...), PROFILE (smoke|load|stress|spike|soak|breakpoint),
# RUN_ID (fixture namespace, default local) and the knobs listed by `make help`.
#   make smoke                       make shopper-guest-checkout PROFILE=load RATE=60
#   make all-smoke                   make browser-shopper-checkout K6_BROWSER_HEADLESS=false
RUN := bin/k6run
# bin/k6run defaults TARGET for runs; `build` needs it here too (an exported-but-empty TARGET counts as set)
TARGET := $(if $(TARGET),$(TARGET),lcl)
SCRIPTS := $(shell find k6/scripts -name '*.js' | sort)
EXPLICIT := k6/scripts/smoke.js k6/scripts/selftest.js k6/scripts/fixtures.js k6/scripts/cleanup.js

.PHONY: help knobs preflight inspect build selftest smoke all-smoke fixtures clean prom-check dash \
        $(patsubst k6/scripts/%.js,%,$(filter-out $(EXPLICIT),$(SCRIPTS)))

help: ## targets and knobs
	@echo "targets:"; grep -E '^[a-z][a-z0-9-]*:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-28s %s\n", $$1, $$2}'
	@echo "scripts (make <layer>-<name>):"; for s in $(SCRIPTS); do n=$${s#k6/scripts/}; n=$${n%.js}; echo "  $${n/\//-}"; done
	@$(MAKE) --no-print-directory knobs

knobs: ## every __ENV knob with default and doc
	@node -e 'const s=require("fs").readFileSync("k6/lib/core/env.js","utf8");const re=/^\s+([A-Z_]+):\s*\{\s*default:\s*([^,]+),(?:\s*type:\s*\x27\w+\x27,)?\s*doc:\s*\x27([^\x27]*)\x27/gm;let m;console.log("knobs:");while((m=re.exec(s)))console.log("  "+m[1].padEnd(22)+m[2].trim().padEnd(18)+m[3]);'

preflight: ## is the target up and answering
	scripts/preflight.sh

inspect: ## parse every script without traffic
	@for f in $(SCRIPTS); do printf '%-48s' "$$f"; k6 inspect "$$f" >/dev/null 2>/tmp/k6-inspect.err && echo ok || { echo FAIL; cat /tmp/k6-inspect.err; exit 1; }; done

build: ## package every script as a self-contained k6 archive for TARGET (the env file is baked in)
	@test -f "k6/config/env/$(TARGET).json" || { echo "no k6/config/env/$(TARGET).json"; exit 1; }
	@set -e; for script in $(SCRIPTS); do \
		relative=$${script#k6/scripts/}; archive=build/k6/$(TARGET)/$${relative%.js}.tar; \
		mkdir -p "$$(dirname "$$archive")"; \
		k6 archive --exclude-env-vars -e TARGET=$(TARGET) --archive-out "$$archive" "$$script"; \
	done; echo "archives for TARGET=$(TARGET) under build/k6/$(TARGET)/ — run one with: k6 run -e TARGET=$(TARGET) <archive>"


selftest: ## every client method once, with expect()
	NO_PROM=1 $(RUN) k6/scripts/selftest.js

smoke: ## one pass over every journey
	$(RUN) k6/scripts/smoke.js

all-smoke: ## every script at PROFILE=smoke
	@for s in $(filter-out $(EXPLICIT),$(SCRIPTS)); do PROFILE=smoke $(RUN) $$s || exit 1; done

fixtures: ## provision the k6- org/store/catalogue and print it
	NO_PROM=1 KEEP_FIXTURES=1 $(RUN) k6/scripts/fixtures.js

clean: ## remove k6- data (API pass, then SQL)
	scripts/cleanup.sh

prom-check: ## does Prometheus hold samples for TESTID
	@curl -sG "$${PROM_QUERY:-http://localhost:9090}/api/v1/query" --data-urlencode "query=sum(k6_http_reqs_total{testid=\"$(TESTID)\"})" | python3 -m json.tool

dash: ## open the "Load test vs app" Grafana dashboard for TESTID (or the newest run)
	@url="$${GRAFANA_URL:-$$(python3 -c "import json; print(json.load(open('k6/config/env/$(TARGET).json')).get('grafanaUrl','http://localhost:3000'))")}"; \
	 testid="$(TESTID)"; [ -n "$$testid" ] || testid="$$(ls -t results/*.json 2>/dev/null | head -1 | xargs -n1 basename 2>/dev/null | sed 's/\.json$$//')"; \
	 link="$$url/d/cvhome-load-test-vs-app?var-testid=$$testid&from=now-3h&to=now"; echo "$$link"; (command -v open >/dev/null && open "$$link") || true

# one target per script: k6/scripts/<layer>/<name>.js -> make <layer>-<name>
define SCRIPT_RULE
$(subst /,-,$(1)): ## run k6/scripts/$(1).js
	$(RUN) k6/scripts/$(1).js
endef
$(foreach s,$(patsubst k6/scripts/%.js,%,$(filter-out $(EXPLICIT),$(SCRIPTS))),$(eval $(call SCRIPT_RULE,$(s))))
