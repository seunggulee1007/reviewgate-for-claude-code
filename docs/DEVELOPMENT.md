# Developing ReviewGate

## Prerequisites

- **Node.js 24+**, installed any way you like. The Xcode build phase and `make` find it with `scripts/find-node.sh`:
  PATH → nvm default alias → newest nvm install → volta → fnm → asdf → Homebrew → /usr/local. Anywhere else, set
  `NODE_BIN=/path/to/node/bin`. Check with `make node`.
- **Xcode 26+** and `brew install xcodegen`
- **Claude Code**, logged in (`claude`, then `/login`)
- `gh`, optional — only for the PR tab and in-app updates

## Build and run (macOS)

```sh
make run      # xcodegen → sidecar build → xcodebuild Debug → launch
make build    # build only → build/Build/Products/Debug/ReviewGate.app
```

Building from Xcode works too (`xcodegen generate`, then open ReviewGate.xcodeproj). The pre-build phase
(`scripts/build-sidecar.sh`) runs `npm ci` (optional dependencies included) only when `node_modules` is missing or the
dependencies in `package-lock.json` changed: it compares a lock hash without the root and workspace `version` fields
(`scripts/lock-hash.mjs`) with the `deps-sha256` in `node_modules/.reviewgate-stamp`, so `make version` alone does not
reinstall. The sidecar bundle (esbuild, under a second) is rebuilt every time. A Release build fails when the sidecar
cannot be built; a Debug build only warns.

| Variable | Effect |
| --- | --- |
| `SKIP_SIDECAR_BUILD=YES` | skip the sidecar step (Swift-only changes) |
| `RG_FORCE_INSTALL=1` | force a dependency reinstall |
| `RG_DRY_RUN=1 ./scripts/build-sidecar.sh` | only print what the step would decide |

### Building without the developer certificate

project.yml signs with an `Apple Development` certificate of team QW7DJ7FBDT. Without it, sign ad hoc:

```sh
xcodegen generate
xcodebuild -project ReviewGate.xcodeproj -scheme ReviewGate -configuration Release -derivedDataPath build \
  CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM="" build
```

A `.app` you received from someone else (ad hoc or not notarized) opens only after its quarantine attribute is removed:

```sh
xattr -dr com.apple.quarantine /Applications/ReviewGate.app
```

### Install location and handing over folders

Run straight from the DMG, the app shows a "running from the disk image" banner. **Move to Applications** copies it to
`/Applications` and reopens it from there once the current app quits; when a copy is already there, it shows both
versions and asks. The current version appears at the bottom of Settings › General, in the About window and in
Help › Copy Diagnostics, as `<version> (<build>)`.

A folder handed over from a terminal or another tool opens in the running app, or brings the window that already has it
to the front:

```sh
open -a ReviewGate ~/work/acme                   # macOS: same as dropping it on the Dock icon
open "reviewgate://open?path=$HOME/work/acme"    # macOS URL scheme — asks first for a folder it has not seen
"%LOCALAPPDATA%\Programs\ReviewGate\ReviewGate.exe" C:\work\acme   # Windows (default install location)
```

## Windows (Electron)

The Electron client in `clients/desktop` runs the same engine in-process. Building it and the NSIS installer
(`npm run dist:win -w clients/desktop`), SmartScreen for an unsigned installer, the `claude.cmd` npm shim and what to
check on a real Windows machine are in [M11-WINDOWS.md](M11-WINDOWS.md).

## Versions and releases

The single source of the version is the root `VERSION` file. After changing it, `make version`
(`node scripts/sync-version.mjs`) writes it to:
- the package.json and package-lock.json of engine, sidecar and clients/desktop
- `engine/src/version.ts` (`ready.engineVersion`)
- project.yml's `MARKETING_VERSION` (CFBundleShortVersionString) and `CURRENT_PROJECT_VERSION` (`git rev-list --count HEAD`)

`make test` first runs `scripts/sync-version.mjs --check` and fails on any mismatch. The build number is not checked.

A release is one command, `make release VERSION=x.y.z` (`scripts/release.sh`). It makes the version commit, builds
Release, makes the DMG and its sha256, and checks the version and signature of both the built app and the app inside the
DMG. Then it tags, pushes the tag and runs `gh release create`. `DRY_RUN=1` runs only the local steps.

The app checks for a new release at launch and every 6 hours through the user's `gh`, announces it in a banner, and on
**Install and Restart** downloads, verifies and swaps the bundle ([PROTOCOL.md §48](PROTOCOL.md)).

## Architecture

npm workspaces (`engine`, `sidecar`) + a Swift package (`Core`) + the Xcode app (`App`). All business logic is in the
TypeScript `engine/`. The Swift side is a thin client speaking protocol v2, and the Electron client embeds the same
engine in-process.

```
engine/    @reviewgate/engine — ReviewEngine (command dispatch, state snapshots), review/gate (the review gate),
           git/ (checkpoint snapshots, diff, revert, branches, ignore, repo), diff/ (unified diff parser, full-file view),
           pr/ (gh CLI, auth, PR store), session/ (Claude Code sessions, budget and permission hooks),
           platform/ (darwin / win32). Tests: vitest (engine/test, golden wire fixtures in engine/test/fixtures/wire)
sidecar/   Node stdio adapter (~70 lines): stdin NDJSON → engine.handle(), engine events → stdout.
           esbuild bundles the engine into one dist/sidecar.mjs → the app bundle's Resources/dist/sidecar.mjs.
           sidecar/test/driver-v2.mjs is the engine-level end-to-end (conformance) script.
Core/      Swift package ReviewGateCore — Engine/ (protocol v2 Codable types, EngineTransport (NDJSON process),
           EngineClient (hello/ready, id correlation, restart), ToolchainLocator (finds node)),
           Session/ (AppState and PRStore mirror the engine state and transcript, AppSettings = UserDefaults),
           Diff/ (decodable models, highlighter)
App/       The SwiftUI shell (Changes / PRs sidebar, diff viewer, chat, settings) — App/Localizable.xcstrings (en/ko)
docs/      PROTOCOL.md (the app ↔ engine contract v2), M9-ENGINE.md (ReviewEngine API and Electron embedding).
           The M*-*.md files are design history.
```

How a turn is reviewed: when a turn starts, the engine snapshots the working tree with `git write-tree` on a temporary
index; when it ends, it snapshots again and diffs the two trees with `git diff-tree`. Revert restores the working tree
from the start snapshot without touching the user's index. Accept does not touch the disk; committing is the user's.
All of this happens in the engine; the apps draw its `state`.

## Tests

```sh
make test                      # version sync check + swift test (Core) + vitest (engine) + node --test (sidecar adapter)
npm run typecheck -w engine    # likewise for sidecar and clients/desktop
npm test -w clients/desktop    # Electron client (vitest)
```

CI (`.github/workflows/ci.yml`) runs on ubuntu-latest and windows-latest: npm ci → typecheck → engine, sidecar and
desktop tests → desktop build. On Windows the engine tests cover the win32 branches. On macos-latest it runs
`swift test --package-path Core` and an ad hoc signed Debug xcodebuild.

### Real-CLI drivers (local only)

Engine-level end-to-end runs against the real `claude`. They need a logged-in Claude Code, so CI does not run them.
Point them at a git repository you can throw away.

```sh
RG_MODEL=haiku node sidecar/test/driver-v2.mjs  ~/scratch/rg-v2       # a turn → restart and restore → reject / request changes / accept → commit → session → branch
RG_MODEL=haiku node sidecar/test/driver-m21.mjs ~/scratch/rg-m21      # review comprehension (PROTOCOL §12–17), a repository on main
RG_MODEL=haiku node sidecar/test/driver-session.mjs ~/scratch/rg-s    # sessions (PROTOCOL §36.5–36.9), about 2 minutes
```

`make verify-cli` runs the whole driver set against the installed Claude Code CLI and, when every driver passes, records
that version as verified, so a new CLI needs no new app release (PROTOCOL §36.8).

## README screenshots

```sh
make screenshots
```

`scripts/screenshots.sh` creates a demo project at `/Users/Shared/acme-shop`, builds a Debug app under its own bundle id
(`io.github.seunggulee1007.reviewgate.screenshots`), and lets the DEBUG-only tour (`App/Debug/ScreenshotTour.swift`)
run one real Claude Code turn (haiku, about $0.01) and save the window in dark and light into `docs/images/`. A
ReviewGate window shows for a few minutes. The installed app, its settings and `~/.reviewgate` are never touched; the
turn leaves a session record under `~/.claude/projects`, as any Claude Code run does. Options (`SHOTS_DIR`, `DEMO_DIR`,
`SHOTS_PROMPT`, `SHOTS_MODEL`, `SHOTS_WIDTH`, `SHOTS_TIMEOUT`) are listed at the top of the script. Claude's output
differs from run to run, so look at every image before committing it.
