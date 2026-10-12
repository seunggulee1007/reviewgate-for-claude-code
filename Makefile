# Node.js >= 24 is discovered by scripts/find-node.sh (PATH, nvm default, volta, fnm, asdf, Homebrew).
# Override with `make NODE_BIN=/path/to/node/bin …`.
NODE_BIN ?= $(shell NODE_BIN= ./scripts/find-node.sh 2>/dev/null)
ifneq ($(strip $(NODE_BIN)),)
export PATH := $(NODE_BIN):$(PATH)
endif
export NODE_BIN

NEED_NODE = @./scripts/find-node.sh >/dev/null

.PHONY: gen sidecar build run test clean version version-check node verify-cli release screenshots

node:
	$(NEED_NODE)
	@echo "node: $(NODE_BIN)/node ($$(node -v))"

# Writes VERSION into the package.json files, package-lock.json, engine/src/version.ts and project.yml.
version:
	$(NEED_NODE)
	node scripts/sync-version.mjs

version-check:
	$(NEED_NODE)
	node scripts/sync-version.mjs --check

# Bumps VERSION, builds Release, packages and checks build/dist/ReviewGate-X.Y.Z.dmg, tags vX.Y.Z and publishes the GitHub
# release (scripts/release.sh, docs/PROTOCOL.md §48). DRY_RUN=1: everything local, the commit / tag / push / release printed.
release:
	@test -n "$(VERSION)" || { echo "usage: make release VERSION=X.Y.Z [DRY_RUN=1]"; exit 1; }
	./scripts/release.sh $(if $(DRY_RUN),--dry-run) $(VERSION)

sidecar:
	$(NEED_NODE)
	./scripts/build-sidecar.sh

gen:
	xcodegen generate

build: gen sidecar
	xcodebuild -project ReviewGate.xcodeproj -scheme ReviewGate -configuration Debug -derivedDataPath build build | tail -20

run: build
	open build/Build/Products/Debug/ReviewGate.app

test: version-check
	swift test --package-path Core
	npm test -w engine
	npm test -w sidecar

# §36.8: every real-CLI driver against the installed Claude CLI; when all pass its version goes into
# ~/.reviewgate/verified-cli.json (no new release needed). IF_NEW=1: skip a version already verified.
verify-cli: sidecar
	IF_NEW=$(IF_NEW) ./scripts/verify-cli.sh

# README screenshots (scripts/screenshots.sh): a demo project, a Debug build under a bundle id of its own, one real
# Claude Code turn on haiku driven by the DEBUG-only tour, the window's PNGs (dark and light) into docs/images/.
# A ReviewGate window shows for a few minutes. SHOTS_DIR, DEMO_DIR, SHOTS_PROMPT, SHOTS_MODEL: see the script.
screenshots:
	$(NEED_NODE)
	./scripts/screenshots.sh

clean:
	rm -rf build ReviewGate.xcodeproj sidecar/dist sidecar/dist-test engine/dist Core/.build
