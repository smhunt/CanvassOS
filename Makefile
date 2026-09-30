# Middlesex Centre Canvass — operator targets. Run on the Docker host from the repo root.
# Requires: docker compose v2, gpg (for backup), shred (coreutils, for purge).

SHELL := /bin/bash
.ONESHELL:
.DEFAULT_GOAL := help

COMPOSE := docker compose
# Tunnel mode: Caddy on 127.0.0.1:3031, TLS at the Cloudflare edge (see README).
COMPOSE_TUNNEL := docker compose -f docker-compose.yml -f docker-compose.tunnel.yml
# Adds a loopback-only database port for the local dev API and the test suite.
COMPOSE_DEVDB := $(COMPOSE_TUNNEL) -f docker-compose.devdb.yml
ENV_FILE := .env
LABEL ?= voters list import $(shell date +%F)
BACKUP_DIR ?= backups
STAMP := $(shell date +%Y%m%d-%H%M%S)

# read one value out of .env without `include` (passwords may contain $ or # which make would mangle)
envval = $$(sed -n 's/^$(1)=//p' $(ENV_FILE) 2>/dev/null | tail -1)

.PHONY: help up up-tunnel devdb demo migrate migrate-status reset-password down restart restart-tunnel build logs ps import import-force backup backup-offsite staging-sync staging-sync-install staging-sync-uninstall staging-sync-status restore purge purge-offsite psql test tunnel-status

help: ## list targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

up: ## build images and start db + api + web(build) + caddy
	@test -f $(ENV_FILE) || { echo "missing $(ENV_FILE) — cp .env.example .env and edit it"; exit 1; }
	$(COMPOSE) up -d --build --remove-orphans
	$(COMPOSE) ps

up-tunnel: ## build and start in TUNNEL mode — Caddy on 127.0.0.1:3031, no 80/443, no Let's Encrypt
	@test -f $(ENV_FILE) || { echo "missing $(ENV_FILE) — cp .env.example .env and edit it"; exit 1; }
	$(COMPOSE_TUNNEL) up -d --build --remove-orphans
	$(COMPOSE_TUNNEL) ps
	@echo
	@echo "origin is http://127.0.0.1:3031 — point the Cloudflare Tunnel at it:"
	@echo "  cloudflared tunnel run <name>   (ingress: $(call envval,DOMAIN) -> http://localhost:3031)"

devdb: ## tunnel-mode stack + database published on 127.0.0.1:5443 for `npm run dev` / `npm test`
	$(COMPOSE_DEVDB) up -d --build --remove-orphans
	$(COMPOSE_DEVDB) ps

restart-tunnel: ## rebuild + restart api/web/caddy in tunnel mode (leaves the database alone)
	# --no-deps: without it compose reconciles `db` against this overlay set and would drop the
	# loopback 5443 publish that docker-compose.devdb.yml adds for the local API and test suite.
	$(COMPOSE_TUNNEL) up -d --build --no-deps api web caddy

tunnel-status: ## is the tunnel-mode origin answering on 127.0.0.1:3031?
	@curl -fsS http://127.0.0.1:3031/api/health && echo || echo "origin not answering on 127.0.0.1:3031"

down: ## stop the stack (keeps volumes/data)
	$(COMPOSE) --profile import down --remove-orphans

restart: ## restart api + caddy (e.g. after editing .env)
	$(COMPOSE) up -d --build api web caddy

build: ## rebuild images without starting
	$(COMPOSE) --profile import build

logs: ## follow logs (SERVICE=api to narrow)
	$(COMPOSE) logs -f --tail=200 $(SERVICE)

ps: ## container status
	$(COMPOSE) ps

import: ## load data/voters_final.csv + data/households.csv (LABEL="voters list export 2026-09-03")
	@test -f data/voters_final.csv -a -f data/households.csv || { echo "put voters_final.csv and households.csv in data/"; exit 1; }
	$(COMPOSE) --profile import run --rm --build importer \
	  --voters /data/voters_final.csv --households /data/households.csv --label "$(LABEL)"

import-force: ## re-import a NEW list even though canvass contacts exist (DELETES contacts — Phase 4 adds a diff)
	$(COMPOSE) --profile import run --rm --build importer \
	  --voters /data/voters_final.csv --households /data/households.csv --label "$(LABEL)" --force

import-diff: ## DRY RUN: report what a new list would change, write nothing (LABEL="voters list export 2026-10-02")
	@test -f data/voters_final.csv -a -f data/households.csv || { echo "put voters_final.csv and households.csv in data/"; exit 1; }
	$(COMPOSE) --profile import run --rm --build importer \
	  --voters /data/voters_final.csv --households /data/households.csv --label "$(LABEL)" --diff

import-apply: ## apply a new list IN PLACE, keeping contacts, signs, consent and turfs (run import-diff first; back up first)
	@test -f data/voters_final.csv -a -f data/households.csv || { echo "put voters_final.csv and households.csv in data/"; exit 1; }
	$(COMPOSE) --profile import run --rm --build importer \
	  --voters /data/voters_final.csv --households /data/households.csv --label "$(LABEL)" --diff --apply

backup: ## encrypted dump -> backups/canvass-<stamp>.sql.gz.gpg (pg_dump | gzip | gpg --symmetric AES256, passphrase = BACKUP_PASSPHRASE from .env)
	@# ONE shell command, joined with backslashes. macOS ships GNU Make 3.81, which predates
	@# .ONESHELL (3.82), so the declaration at the top of this file is SILENTLY IGNORED there and
	@# every recipe line would otherwise run in its own shell. Written as separate lines, $$PASS was
	@# empty by the time gpg saw it — encrypting the voters list with an EMPTY passphrase — and
	@# `set -o pipefail` never applied, so a failed pg_dump was masked by a successful gzip and
	@# produced a truncated backup that still exited 0. Do not split these back into separate lines.
	@PASS=$(call envval,BACKUP_PASSPHRASE); test -n "$$PASS" || { echo "set BACKUP_PASSPHRASE in .env"; exit 1; }; \
	mkdir -p $(BACKUP_DIR); \
	set -o pipefail; \
	$(COMPOSE) exec -T db pg_dump -U canvass --clean --if-exists --no-owner --no-privileges canvass \
	  | gzip -9 \
	  | gpg --batch --yes --symmetric --cipher-algo AES256 --pinentry-mode loopback \
	        --passphrase "$$PASS" -o $(BACKUP_DIR)/canvass-$(STAMP).sql.gz.gpg; \
	ls -lh $(BACKUP_DIR)/canvass-$(STAMP).sql.gz.gpg; \
	echo "restore with: make restore FILE=$(BACKUP_DIR)/canvass-$(STAMP).sql.gz.gpg"

backup-offsite: ## make backup + ship it (and any sign photos) to $BACKUP_S3_URI, verified — this is the cron target
	@./scripts/backup-offsite.sh

staging-sync: ## MAC ONLY: restore the newest production dump from S3 into the local `canvass` now (the LaunchAgent does this at 04:15 and 16:15)
	@./scripts/staging-sync.sh run

staging-sync-install: ## MAC ONLY: load the twice-daily LaunchAgent (04:15, 16:15; re-run after changing the script)
	@./scripts/staging-sync.sh install

staging-sync-uninstall: ## MAC ONLY: unload the staging LaunchAgent
	@./scripts/staging-sync.sh uninstall

staging-sync-status: ## MAC ONLY: is the LaunchAgent loaded, what was restored last, log tail
	@./scripts/staging-sync.sh status

restore: ## restore FILE=backups/canvass-....sql.gz.gpg into an EMPTY database (run after `make up` on a fresh volume)
	@# One shell command — same GNU Make 3.81 reason as `backup` above. Split back into lines, $$PASS
	@# is empty here too, which would happily "restore" a backup that was written with the same bug
	@# and so hide it.
	@test -n "$(FILE)" || { echo "usage: make restore FILE=backups/canvass-<stamp>.sql.gz.gpg"; exit 1; }; \
	PASS=$(call envval,BACKUP_PASSPHRASE); test -n "$$PASS" || { echo "set BACKUP_PASSPHRASE in .env"; exit 1; }; \
	set -o pipefail; \
	gpg --batch --pinentry-mode loopback --passphrase "$$PASS" -d "$(FILE)" \
	  | gunzip \
	  | $(COMPOSE) exec -T db psql -U canvass -v ON_ERROR_STOP=1 canvass

purge: ## AFTER THE ELECTION: stop the stack, delete ALL volumes (database, web, certs) and shred data/*.csv
	@echo "This permanently destroys the database volume, the web volume, sign photos, Caddy state and shreds data/*.csv."
	@echo "Encrypted backups in $(BACKUP_DIR)/ are NOT touched — delete them yourself once they are no longer needed."
	@read -r -p "Type PURGE to continue: " ans; [ "$$ans" = "PURGE" ] || { echo "aborted"; exit 1; }
	@# The staging refresh would otherwise pull the list straight back onto this Mac.
	@if [ "$$(uname)" = Darwin ]; then ./scripts/staging-sync.sh uninstall; fi
	$(COMPOSE) --profile import down --volumes --remove-orphans
	find data -maxdepth 1 -type f \( -name '*.csv' -o -name '*.xlsx' \) -print -exec shred -u -z -n 3 {} +
	# Sign photos show people's houses, so they are destroyed with everything else. The signphotos
	# volume goes with `down --volumes` above; this catches a local run that wrote to ./data.
	@if [ -d data/sign-photos ]; then \
	  find data/sign-photos -type f -print -exec shred -u -z -n 3 {} + ; rmdir data/sign-photos 2>/dev/null || true; \
	fi
	$(MAKE) purge-offsite CONFIRM=PURGE
	@echo "purged. Also remove: $(BACKUP_DIR)/*.gpg and $(BACKUP_DIR)/staging/ (the staging dumps and their log on the Mac), any copies of the list on laptops/phones, and the pipeline outputs."
	@echo "On AWS also: terminate the instance (delete-on-termination destroys the EBS volume), delete"
	@echo "the bucket, release the Elastic IP, revoke the IAM role, confirm no snapshots or AMIs exist,"
	@echo "then prove nothing survives:  aws resourcegroupstaggingapi get-resources \\"
	@echo "  --tag-filters Key=Project,Values=canvass-2026 --region ca-central-1"

purge-offsite: ## destroy the off-site backups in $BACKUP_S3_URI — needs ADMIN credentials (the instance role cannot delete)
	@# One logical shell command: macOS ships GNU Make 3.81, which predates .ONESHELL, so a recipe
	@# written as separate lines would run each in its own shell and lose every variable.
	@URI="$(call envval,BACKUP_S3_URI)"; \
	if [ -z "$$URI" ]; then echo "no BACKUP_S3_URI configured — nothing off-site to destroy"; exit 0; fi; \
	URI="$${URI%/}"; \
	if [ "$(CONFIRM)" != "PURGE" ]; then \
	  echo "This permanently destroys every encrypted backup under $$URI."; \
	  read -r -p "Type PURGE to continue: " ans; [ "$$ans" = "PURGE" ] || { echo "aborted"; exit 1; }; \
	fi; \
	AWS="aws $${AWS_PROFILE:+--profile $$AWS_PROFILE} $${AWS_REGION:+--region $$AWS_REGION}"; \
	$$AWS s3 rm "$$URI" --recursive; \
	LEFT="$$($$AWS s3 ls "$$URI" --recursive | wc -l | tr -d '[:space:]')"; \
	if [ "$$LEFT" != "0" ]; then \
	  echo "STILL PRESENT: $$LEFT object(s) under $$URI — NOT purged." >&2; \
	  echo "Re-run with admin credentials (AWS_PROFILE=...); the instance role cannot delete." >&2; \
	  exit 1; \
	fi; \
	echo "off-site backups destroyed and verified empty: $$URI"

demo: ## (re)build canvass_demo — fabricated residents for screenshots, video and training
	@echo "Building canvass_demo from entirely fabricated data (never the voters list)."
	PW=$(call envval,POSTGRES_PASSWORD)
	$(COMPOSE) exec -T db psql -U canvass -d postgres -c 'DROP DATABASE IF EXISTS canvass_demo'
	$(COMPOSE) exec -T db psql -U canvass -d postgres -c 'CREATE DATABASE canvass_demo'
	$(COMPOSE) exec -T db psql -U canvass -d canvass_demo -v ON_ERROR_STOP=1 < db/schema.sql > /dev/null
	PSQL="$(COMPOSE) exec -T db psql -U canvass -d canvass_demo" ./db/migrate.sh
	python3 demo/seed_demo.py --database-url "postgresql://canvass:$$PW@localhost:5443/canvass_demo"
	@echo
	@echo "Run the demo stack alongside the real one:"
	@echo "  cd api && set -a && . ../.env.demo && set +a && npx tsx watch src/server.ts"
	@echo "  cd web && CANVASS_WEB_PORT=3032 CANVASS_API_PORT=3132 npm run dev"

migrate: ## apply pending db/migrations/*.sql to the running database
	./db/migrate.sh

migrate-status: ## list applied and pending migrations
	./db/migrate.sh status

reset-password: ## issue a password-reset link (EMAIL=someone@example.com)
	@./scripts/reset-password.sh "$(EMAIL)"

psql: ## psql shell inside the db container
	$(COMPOSE) exec db psql -U canvass canvass

test: ## run the API tests (needs CANVASS_TEST_DESTRUCTIVE=1 + TEST_DATABASE_URL on a throwaway db — see README)
	cd api && npm test
