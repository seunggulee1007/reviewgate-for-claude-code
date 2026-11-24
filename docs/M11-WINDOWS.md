# M11 — Windows desktop client (Electron)

`clients/desktop/` is the Windows-first ReviewGate client: the same in-process engine as the sidecar
(`@reviewgate/engine`, docs/M9-ENGINE.md §3.2) inside Electron's main process, one engine per
window (a window is a workbench, docs/M10-WORKBENCHES.md), a React renderer that mirrors the Mac app
(Sidebar · diff pane · chat) with Monaco for side-by-side diffs. It runs on macOS for development.

## Build / run / package

```sh
npm ci                                    # repo root (workspaces: engine, sidecar, clients/*)
npm run typecheck -w clients/desktop      # renderer + main tsconfigs
npm test -w clients/desktop               # vitest: src/main/*.test.ts (settings / IPC / cmd.exe quoting / claude.cmd / orphans)
npm run dev -w clients/desktop            # vite HMR + esbuild watch + electron
npm run build -w clients/desktop          # dist/main/main.mjs, dist/main/preload.cjs, dist/renderer/
npm run dist:win -w clients/desktop       # NSIS installer → clients/desktop/release/ReviewGate Setup <version>.exe
npm run dist:mac -w clients/desktop       # unsigned .app → clients/desktop/release/mac-arm64/ReviewGate.app (dev only)
REVIEWGATE_PROJECT=/path/to/repo npm run dev -w clients/desktop   # open a project in the first window
```

- Node ≥ 20 is only needed to build; the packaged app bundles Electron's Node.
- `dist:win` builds on macOS without wine: `electron-builder.yml` sets `win.signAndEditExecutable: false`
  (no rcedit → the exe keeps Electron's icon/version resource). No code signing; SmartScreen will warn.
- A release's installer is built on Windows by `.github/workflows/windows-installer.yml`, started by publishing the
  release (or by hand: `gh workflow run windows-installer.yml -f tag=vX.Y.Z`). There rcedit runs
  (`-c.win.signAndEditExecutable=true`), so the exe carries the app icon and version. It is named
  `ReviewGate-Setup-<version>.exe`, installed silently and launched once (still running after 20 s; a screenshot is
  the run's `smoke-screenshot` artifact), then attached to the release with its `.sha256`. Still unsigned.
- `dist:mac` uses `CSC_IDENTITY_AUTO_DISCOVERY=false` semantics (`mac.identity: null`) → unsigned, for local runs only.
- Nothing external is bundled: the engine spawns `claude`, `gh` and `git` from `PATH` (or the paths in Settings → Advanced).
  `electron-builder.yml` excludes `node_modules/@anthropic-ai/claude-agent-sdk-*/**` for every target: those
  optional SDK packages hold a ~200 MB native claude per platform that ReviewGate never runs (the engine always
  passes `pathToClaudeCodeExecutable` = the located claude and fails with `cli_not_found` when there is none), and a
  mac-built Windows installer used to carry the **darwin-arm64** one. No win32 package is needed either.

### Terminal: node-pty and xterm.js (Stage 3, PROTOCOL §57.17)

- **Pins (exact).** `node-pty` 1.1.0 (a `dependency`: it ships) and `@xterm/xterm` 6.0.0 with `@xterm/addon-fit` 0.11.0,
  `-webgl` 0.19.0, `-unicode11` 0.9.0, `-web-links` 0.12.0, `-search` 0.16.0, `-clipboard` 0.2.0 (`devDependencies`:
  vite bundles them into the renderer, as with Monaco and React). Licences: `clients/desktop/THIRD_PARTY_NOTICES.md`,
  shipped next to the app as `resources/THIRD_PARTY_NOTICES.md` (`extraResources`).
- **No rebuild for Electron.** node-pty 1.1.0 is built with node-addon-api (N-API), so its prebuilds
  (`prebuilds/{win32-x64,win32-arm64,darwin-x64,darwin-arm64}`) load in Electron 44 as they are; `npmRebuild: false`
  stays. win32-x64 carries ConPTY itself (`prebuilds/win32-x64/conpty/{conpty.dll,OpenConsole.exe}`), which the app always
  uses (`useConptyDll`). If a future node-pty drops prebuilds: `npx @electron/rebuild -f -w node-pty -v 44.5.1`.
- **Linux (CI only).** There is no linux prebuild: `npm ci` compiles it with node-gyp (python, make, g++ — present on the
  GitHub ubuntu runner). npm ≥ 11.19 blocks dependency install scripts unless `allowScripts` lists them, so the root
  `package.json` allows `node-pty@1.1.0` (and only it). Bumping node-pty means bumping that entry too.
- **Loading** (`main/pty/nodePty.ts`): lazily, once per process. Packaged: `require(<resources>/app.asar.unpacked/
  node_modules/node-pty)` by path; development: `require("node-pty")`. On Windows it needs build ≥ 18309 (Windows 10
  1903) — below that there is no PTY ("Terminal chat needs Windows 10 1903 or later"; winpty is never used). The result
  is hello's `capabilities.terminalChat` and `rg:pty:info`. macOS (development): the darwin prebuild's `spawn-helper`
  comes without its executable bit (`posix_spawnp failed`); the loader sets it back.
- **Self-test.** `ReviewGate.exe --rg-pty-selftest=<out.json>` (or `npx electron clients/desktop --rg-pty-selftest=…`)
  loads node-pty, runs `%ComSpec% /d /c echo rg-pty-ok` through ConPTY with the bundled `conpty.dll`, writes
  `{ok, nodePtyDir, conptyDll, openConsole, electron, osBuild, error?}` and exits 0 / 1. It runs before the
  single-instance lock (a running ReviewGate is not disturbed) and opens no window and no settings. CI runs it on Windows
  after the desktop build (`npx electron clients/desktop --rg-pty-selftest=…`, ci.yml) and in the silently installed app
  (windows-installer.yml), which also checks that node-pty's `lib`, `conpty.node`, `conpty.dll`, `OpenConsole.exe` and
  `resources/THIRD_PARTY_NOTICES.md` shipped and that no `.pdb`, `src`, `deps`, `third_party`, `win32-arm64` or `darwin-*`
  did. `OpenConsole.exe` joins the Defender process exclusions of the CI job.
- **Packaging.** `asarUnpack: node_modules/node-pty/**` — the `.node` files, the conout worker thread, `conpty.dll` /
  `OpenConsole.exe` and the console-list agent must be real files; main requires node-pty from
  `resources/app.asar.unpacked/node_modules/node-pty` by path. Excluded: node-pty's `src`, `deps` (winpty sources),
  `third_party` (a second ConPTY copy), `scripts`, `typings`, `binding.gyp`, every `.pdb`, `node-addon-api`, and the
  other OS's prebuilds (win: `darwin-*` and `win32-arm64`; mac: `win32-*`).
- **No fuse that disables RunAsNode**: node-pty's console-list agent `fork()`s, and the engine's `cli.js` version probe
  runs Electron as Node.

## Layout of `clients/desktop/src`

| Path | Role |
|---|---|
| `main/main.ts` | app lifecycle, one `ReviewEngine` per `BrowserWindow`, `rg:cmd` / `rg:request` / `rg:evt` IPC, file logger, `--e2e` |
| `main/menu.ts` | File / View / Help menus (Help → Copy Diagnostics, Logs Folder) |
| `main/settings.ts` | `userData/settings.json` (same keys as the Mac `AppSettings`) → engine `Settings`; win32 claude detection |
| `main/settingsGuard.ts` | which settings keys / values the renderer may write; executable-path validation |
| `main/navigationGuard.ts`, `main/ipcGuard.ts` | app-only navigation, no popups / webviews; engine-command allowlist, http(s)-only external URLs |
| `main/editor.ts`, `main/winCmd.ts` | Open in VS Code / IntelliJ; cmd.exe quoting for `.cmd` / `.bat` shims |
| `main/winClaude.ts` | resolves an npm `claude.cmd` shim to a spawnable program |
| `main/orphans.ts` | child-process listing for the e2e (ps / PowerShell CIM / wmic) |
| `main/update.ts`, `main/updateDownload.ts`, `main/updateVerify.ts`, `main/updateInstall.ts` | PROTOCOL §48: the release check and the in-app update (download from GitHub hosts, checksum / name / version / PE checks, the wait for Claude, the installer after the engines stop, the launch's notice) |
| `main/pty/` | PROTOCOL §57.17: `nodePty.ts` (loading, availability), `selftest.ts` (`--rg-pty-selftest`), `terminalLaunch.ts` (claude / shell launches), `ptyHub.ts` (a window's PTYs, flow control, lifecycle), `ptyWindow.ts` (the hub wired to Electron) |
| `main/e2e.ts` | `--e2e` harness: report / screenshot / secondary-window IPC, orphan-process count, exit code |
| `preload.ts`, `shared/ipc.ts` | the `window.rg` bridge |
| `renderer/App.tsx` | layout: Sidebar (Changes \| PRs) · `DiffPane` / `PRDetail` · `ChatPane` · `<Dialogs />`; empty state with recents; menu actions — each pane inside an `ErrorBoundary` |
| `renderer/store.ts` | zustand: last `ReviewState` + transcript, selection, diff caches, dialogs |
| `renderer/e2e.ts` | the scripted scenario (below), driven through the store |
| `renderer/i18n/` | `ko.json` generated by `scripts/gen-i18n.mjs` from both `Localizable.xcstrings` + `ko.extra.json` |

`hello` (protocol v2, `client: "windows"` on win32) is sent by the main process right after the engine is
created; the renderer only subscribes (`window.rg.onEvent` replays the current snapshot via `rg:attach`)
and opens the initial project (`REVIEWGATE_PROJECT` → `--rg-project` → `window.rgInitialProject`).

## Renderer trust and Windows hardening (2026-10-20)

The renderer is treated as untrusted input to main:

- **Sandboxed renderer** — `sandbox: true` (+ `app.enableSandbox()`), `contextIsolation: true`, `nodeIntegration: false`,
  `nodeIntegrationInWorker: false`, `webviewTag: false`. The preload uses only `contextBridge` / `ipcRenderer` and the
  sandbox's `process.argv` / `process.platform` (`window.rg.sep` no longer comes from `node:path`).
- **Settings** — `rg:setSettings` keeps only the keys a Settings control writes, each type- and range-checked
  (`settingsGuard.ts`); everything else (`openWindows`, `recentProjects`, `cachedCapabilities`, `ui`, unknown keys) is
  dropped and logged. **`claudePath` / `ghPath` / `gitPath` are not renderer-writable**: Settings → Advanced → Toolchain
  overrides shows the path with **Choose…** (main's native file dialog → absolute, existing regular file, executable off
  Windows, named `claude` / `gh` / `git` — on Windows `claude.exe` / `claude.cmd`, `gh.exe`, `git.exe`) and
  **auto-detect** (clear). A stored override that fails the same check is ignored at load (logged).
- **Navigation** — every webContents (`web-contents-created`): `will-navigate` / `will-redirect` to anything but the
  renderer's own `index.html` (or the vite dev server origin under `npm run dev`) is cancelled — http(s) links open in
  the OS browser through the `rg:openExternal` allowlist; `window.open` is denied; `<webview>` never attaches.
- **CSP** — adds `object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`; the packaged build's
  `connect-src` is `'self'` only (a vite build plugin strips the dev server's HMR socket, which `npm run dev` keeps).
- **Open in Editor** — only an absolute path and a positive line reach a spawn.
- **Electron 44.5.1** (was 33.4.11, EOL). `console-message` uses the event details (positional args are deprecated).

Windows-specific:

- **`claude.cmd`** — Node ≥ 18.20.2 / 20.12.2 refuses to spawn `.cmd` / `.bat` without a shell (EINVAL). Main resolves
  the npm shim before the engine sees it (`winClaude.ts`, at startup for the PATH one and for an override): the `.exe` the
  shim runs → a native `claude.exe` inside `node_modules/@anthropic-ai/claude-code` → the shim itself when only `cli.js`
  exists (the engine then runs `cli.js` under Electron-as-node, `session/claude.ts resolveClaudeExecutable`) →
  `%USERPROFILE%\.local\bin\claude.exe`. In that `cli.js` case the engine's `claude --version` probe still execFile()s
  the shim and gets no version (cosmetic; engine change below).
- **Open in VS Code / IntelliJ** — `code.cmd` / `idea.bat` run as `cmd.exe /d /s /c ""<exe>" <args>"` with every argument
  quoted and `^`-escaped twice (cross-spawn's scheme, `winCmd.ts`), so spaces, `&`, `^`, `%VAR%`, `( )`, `!` and Korean
  in a path arrive unchanged (unit tests model cmd.exe's two parses + CommandLineToArgvW).
- **ErrorBoundary** — around the root and the sidebar, banners, diff / history / PR / start panes, chat, agent panel and
  dialogs: one pane crashing shows "화면 오류가 발생했어요" with **다시 그리기** (remount) / **로그 복사**; the error, plus
  `window.onerror` / unhandled rejections, goes to the main log (`[w<id>:error] renderer: …`).
- **e2e orphans on Windows** — `tasklist` has no parent-pid column, so children of main are listed with
  `Get-CimInstance Win32_Process -Filter "ParentProcessId=<pid>"` (wmic fallback); Electron / ReviewGate helpers and
  `conhost.exe` are excluded.

Verified on macOS 15 (2026-10-20, Electron 44.5.1): `npm test` 41 passed; typecheck + build clean; a smoke launch
(scratch `userData`) showed `sandbox: true`, `typeof process/require === "undefined"` in the page, `setSettings({claudePath})`
ignored, navigation to `file:///etc/hosts` and `window.open` blocked, a forced Sidebar error rendering the recovery UI while
the other panes stayed and Redraw restoring it (logged as `[w1:error] renderer: [Sidebar] …`); the full `--e2e` passed —
`{"ok": true, "turns": 13, "cost": 0.4963, "contextTokens": 45280, "maxStateBytes": 18468, "collectRetries": 0, "orphans": 0}`,
115 steps, exit 0. `dist:mac` → `ReviewGate.app` 317 MB (was 441 MB) with no `claude-agent-sdk-*` package in the asar or
`app.asar.unpacked`. `dist:win` was not re-run (it downloads the win32 Electron zip).

Engine-side follow-up (not changed here; engine/ is owned elsewhere): `platform/toolchain.ts versionOf` should run a
`.cmd` through `cmd.exe /d /s /c` (or `resolveClaudeExecutable`'s `cli.js` + `ELECTRON_RUN_AS_NODE`) so the version shows
for a cli.js-only npm install; `platform/win32.ts openTerminal` passes `command` to `cmd /c start cmd /k` unescaped
(fine for its fixed `gh auth login …` strings, unsafe for anything user-derived).

## Engine paths on Windows (2026-10-20)

Design (docs/PROTOCOL.md §20; `engine/src/platform/paths.ts`):
- Repo-relative paths on the wire stay POSIX (`src/a.ts`). Absolute paths (`project.root`, workbench paths, lock /
  gitdir paths, `changedOutside`, `toolFiles`) are native: `C:\Users\x\repo`, drive letter uppercased. Every path taken
  from git (`C:/…`, MSYS `/c/…`) goes through `toNativeAbs`. Before this change `project.root` and the worktree list
  were git's `C:/…` while paths built by Node were `C:\…`, so equality checks failed (`isCurrent`, worktree removal,
  the switch_project wait, the lock-conflict path) and the managed-worktree hash depended on the spelling.
- No string-prefix containment anywhere: `isInside` / `toRepoRelative` / `normalizeForCompare` resolve symlinks and,
  on Windows, 8.3 short names (`realpathSync.native`), then compare component by component — case-insensitive, both
  separators, `\\?\` / `\\.\` / `\??\` prefixes, trailing dots/spaces dropped.
- Security-relevant fixes on Windows (each was a real hole before):
  - **Containment** (`preEdit` / `canUseTool` outside-the-project `ask`): the old check compared `C:/…` (realpath with
    `/`) against the root, case-sensitively; `C:\REPO\x` or `c:\repo\x` for a repo at `C:\repo` counted as outside
    (spurious ask) and, worse, plan-file auto-allow and the review's tool attribution silently failed. Alternate data
    streams (`a.txt:hidden`, `src::$INDEX_ALLOCATION\x`) — content git never sees, i.e. a review bypass — device names
    (`NUL`, `COM1.txt`) and device namespaces (`\\.\pipe\…`, `\\?\Volume{…}`) are never inside: they always ask.
  - **`.git` detection**: `.git.`, `.git ` (Windows strips trailing dots/spaces), `.git::$INDEX_ALLOCATION`,
    `.git:stream` and the 8.3 alias `GIT~1` are `.git`; a `--separate-git-dir` path is matched by component, so
    `gd::$INDEX_ALLOCATION\hooks\x` is inside the git dir `gd`. Before, `C:\repo\.git.\hooks\pre-commit` (Windows
    writes it to `.git\hooks`) was neither a `.git` component nor outside the root, so the edit was auto-allowed.
  - **Plan files** (`<home>/.claude/plans/`): matched with `toRepoRelative`, so a native plans dir no longer fails the
    auto-allow (it denied plan writes on Windows) and a stream / lookalike folder never gets it.
  - **`cannot_remove_current`** compares canonical paths, so another spelling of the current worktree is still refused.
- `turn_end.toolFiles` and the post-Bash "explained by an edit" set are keyed by `normalizeForCompare`, so an Edit of
  `c:/repo/a.ts` and a post-Bash `C:\repo\a.ts` are one file.
- `writeBlob` (restore fallback) recreates a symlink entry as a symlink on Windows when the repository has
  `core.symlinks=true`; otherwise (Git for Windows' default) it writes the target text, as git itself does there.

Engine tests on windows-latest (`.github/workflows/ci.yml`, no `continue-on-error`):
- The win32 path rules are pure (`path.win32` + an explicit flavor) and run on every OS (`test/platform.paths.test.ts`).
- Skips, each only when the capability is really missing (probed): the two symlink tests in `engine.hunks.test.ts`
  (`fs.symlink` fails without the privilege; the runner has it, so they run there with `core.symlinks=true`); exec-bit
  assertions where `chmod` cannot set the bit (Windows) — the mode-only refusal of `reject_hunks` is covered there by
  a change recorded through the index (`git update-index --chmod=+x`, `core.fileMode=false`), which is how a mode change
  reaches git on Windows at all. Remaining win32 skips (6 of 588 on the runner): the two exec-bit tests in
  `git.checkpoint.test.ts` (no executable bit), SIGTERM→SIGKILL escalation in `util.exec.test.ts` (Windows has no
  catchable SIGTERM), the POSIX `locateToolchain` fixture and the darwin-only login-shell test in `platform.test.ts`,
  and the opt-in live `gh` suite (`GH_LIVE=1`, skipped everywhere). The `exec` and `gh auth status` tests now use node
  children / a node-based fake `gh.exe` and run on Windows too.
- Test-environment fixes, not product changes: a fake `gh.exe` (node.exe hard-linked + a `NODE_OPTIONS --require`
  preload, since execFile cannot start a script or `.cmd`), a node clean/smudge filter instead of MSYS `sed`, explicit
  `core.autocrlf` / `core.symlinks` in temp repos, and `rmSync` retries for EPERM/EBUSY after a child exits.
- Client note: the Electron renderer's tool-path → repo-relative matching (`clients/desktop/src/renderer/paths.ts`) now
  folds case for Windows roots. Per-project UI settings are keyed by a hash of `project.root`; on Windows that string
  changed from `C:/…` to `C:\…`, so UI state saved by an earlier Windows build is not found once (layout only). The Swift
  Mac app only ever sees POSIX paths and is unaffected.

## Verified on macOS (real engine + real `claude`)

`REVIEWGATE_PROJECT=/tmp/rg-scratch npx electron . --e2e` runs `src/renderer/e2e.ts`:

1. wait `state.project` + `session.open` + `gate.canSend`
2. `send "Reply with the word pong only"` → `turn_end`
3. `send "Append one new line containing exactly the word 'electron' at the very end of README.md (it must become the last line of the file), and create e1.txt with 3 lines. Do only that."` → `gate.phase == "reviewing"` (any permission card is auto-allowed by the script)
3a. `session_new` during the pending review (docs/PROTOCOL.md §9) → accepted, the review list / snapshot A / both pending files survive the switch, the new chat's `send` merges into the same review, then `session_open` back
4. `select_file README.md` (→ `file_diff`), `full_file README.md`
5. `accept README.md`, `reject e1.txt` → on disk: README's last line is `electron`, `e1.txt` absent
6. `add_note` on README + `request_changes "Change the appended line to 'electron v2'"` → reviewing → `accept_all`
7. screenshot with README in the diff pane (`REVIEWGATE_E2E_SHOT_DIR/m11-desktop.png`)
8. second `BrowserWindow` on the same project → `state.lockConflict` set there (assert) → window closed
9. one JSON line on stdout, engines disposed, orphan child processes counted, exit 0/1

Result (2026-09-16, macOS 15, Electron 33.4.11, Claude Code CLI on PATH; fresh repo, after the
`session_new`-during-a-pending-review change): `{"ok": true, "turns": 11, "cost": 0.0455, "contextTokens": 35081,
"maxStateBytes": 9078, "collectRetries": 0, "orphans": 0}` (exit 0; 96 scripted steps passed, including step 3a —
`chat switching allowed while files are plainly pending`, `review list survived the new chat
([["README.md","pending"],["e1.txt","pending"]])`, `the new chat's send merged into the same review`,
`three chats listed (3)`, `both files still pending after switching back (2)`).

Result (2026-09-14, macOS 15, Electron 33.4.11, Claude Code CLI on PATH):

Summary line: `{"ok": true, "turns": 3, "cost": 0.5627, "contextTokens": 34582, "maxStateBytes": 7731, "orphans": 0}` (exit 0; 25 scripted steps passed)

```json
{
  "project": "/tmp/rg-scratch",
  "role": "primary",
  "ok": true,
  "turns": 3,
  "cost": 0.5627,
  "contextTokens": 34582,
  "maxStateBytes": 7731,
  "screenshot": "<REVIEWGATE_E2E_SHOT_DIR>/m11-desktop.png",
  "secondary": {
    "role": "secondary",
    "ok": true,
    "lockConflict": {
      "path": "/private/tmp/rg-scratch",
      "pid": 29216,
      "since": "2026-09-14T02:27:12.271Z",
      "client": "mac"
    },
    "dialog": "lockConflict",
    "project": null
  },
  "orphans": 0,
  "orphanNames": []
}
```

Screenshot (`m11-desktop.png`): sidebar with `rg-scratch · main`, README.md marked accepted, the diff pane showing `+electron v2`, the chat with the transcript (Read/Edit/Write tool rows, an auto-allowed Bash permission card) and the HUD strip (context 34.7k / 1M, session cost, turn count, budget 1/5 · 4/200).

Artifacts built on macOS:
- `clients/desktop/release/ReviewGate Setup 0.1.0.exe` — NSIS x64 installer, 145,043,141 bytes (unsigned, default Electron icon)
- `clients/desktop/release/win-unpacked/` — the unpacked x64 app (488 MB)
- `clients/desktop/release/mac-arm64/ReviewGate.app` — unsigned arm64 .app for local runs (441 MB)

## Updating (PROTOCOL §48 "Windows")

- **By hand: run the new installer over the old one — no uninstall needed.** It finds the installed ReviewGate, installs
  into the same folder (also one you picked), runs the old version's uninstaller silently first, and keeps your settings
  and logs (`%APPDATA%\ReviewGate`) and the Start menu / desktop shortcuts. What guarantees it is in
  `clients/desktop/electron-builder.yml`: `appId` fixed and no `nsis.guid` (the GUID that keys the install's registry
  entry), `productName` fixed, `perMachine: false`, `deleteAppDataOnUninstall: false`.
- **From the app** (0.5.18 on): the banner's [Install and Restart] downloads `ReviewGate-Setup-X.Y.Z.exe` and its
  `.sha256` from the GitHub release (GitHub hosts only, ≤ 400 MB), checks the checksum, the name, the version and the PE
  header, waits until no window has Claude working or a card waiting, then quits and runs
  `ReviewGate-Setup-X.Y.Z.exe /S /currentuser --updated --force-run` once every engine has stopped. ReviewGate reopens
  as X and says "Updated to ReviewGate X" (or why it did not install, with [Try Again]). [Download Page] is always
  there for doing it by hand. An all-users install (under Program Files) is updated the same way but elevated: Windows
  asks once for administrator rights (UAC) and the installer runs with `/allusers`; declined, ReviewGate reopens and says
  "Administrator rights were not given".
- **What the checksum is worth.** It comes from the same release as the installer: it catches a corrupted or truncated
  download, not a compromised release. The installer is not code-signed yet; Authenticode verification before running it
  comes with the SignPath signing.

## Windows verification checklist (for a Windows tester)

Prerequisites
- Node is **not** required for the packaged app.
- Git for Windows (`git` on PATH), GitHub CLI `gh` (on PATH), Claude Code CLI installed and logged in
  (`claude --version` and a `claude` chat work in a terminal).
- For a GitHub Enterprise host: `gh auth login --hostname ghe.example.com` done or use Settings → Accounts → Log in….

First run
1. Run `ReviewGate Setup 0.1.0.exe` (per-user install, folder selectable). SmartScreen: "More info → Run anyway" (unsigned).
2. Settings (Ctrl+,) → General: check the detected `claude` / `gh` / `git` paths; if one is empty use **Choose…** (a file dialog — paths can no longer be typed).
3. Settings → Accounts → Log in… for `ghe.example.com` (opens a terminal with `gh auth login`), then Refresh.
4. File → Open Project… (Ctrl+O): pick a git repository. The title bar shows `<repo> — <branch>`.

Scenarios
- [ ] `claude.exe` spawn + streaming: send "Reply with the word pong only" → text streams into the transcript, HUD shows tokens / cost / turn count.
- [ ] Permission card: send "Run `dir >> x.txt` with Bash" → an orange permission card appears; Allow → the tool runs; Deny → the model reports it.
- [ ] Accept / reject on an `autocrlf=true` repository containing a file with a Korean name (e.g. `문서/안내.md`): ask for an edit to it, the diff shows the change (no full-file CRLF churn), Accept keeps it, Reject restores the file byte-identically (`git status` clean).
- [ ] Close the window → Task Manager shows no leftover `claude.exe` / `node.exe` (Details tab, sort by name).
- [ ] File → New Workbench… → a second window opens on the new worktree with its own session; the first window's Workbench menu lists it.
- [ ] Open the same folder in a second window (File → New Window → Open Project… same path) → "This workbench is already open" dialog; Take over works.
- [ ] PRs tab: the list from GHE loads (Mine / Review requested), opening a PR shows files + diff, an inline draft comment + Submit review (COMMENT) lands on GHE.
- [ ] A folder that is no git repository (e.g. `C:\Users\dev\notes`): the dialog's **Track without git** opens it (no `.git` appears in it), a turn's edits are reviewed as usual (accept / reject), the header says "Not a git repository — changes tracked by ReviewGate", the PRs tab and the Workbenches menu section are gone, Commit is disabled with the reason (PROTOCOL §59).
- [ ] Korean UI: with a Korean Windows locale the UI is in Korean; shortcuts read `Ctrl+…`.

Needs a real Windows machine (2026-10-20 hardening — verified on macOS only by unit tests / smoke launch):
- [ ] npm-installed Claude Code (`npm i -g @anthropic-ai/claude-code`, only `claude.cmd` on PATH): a session starts, the log
      shows `claude on PATH: …\claude.cmd → …\claude.exe` (or keeps the `.cmd` when the package only has `cli.js`); no `spawn EINVAL`.
- [ ] Native installer only (`%USERPROFILE%\.local\bin\claude.exe`): unchanged behaviour.
- [ ] Settings → Choose… for claude: picking `claude.exe` / `claude.cmd` works; picking `notepad.exe` is refused ("Not used: the file must be named …").
- [ ] Open in VS Code on a file under a folder with a space, `&`, `%TEMP%`, `^` and Korean in its name (e.g. `C:\work\R&D 100%\한글^폴더\a.ts`)
      → VS Code opens that file at the line; nothing else runs.
- [ ] Open in IntelliJ (`idea64.exe`) on the same file.
- [ ] `npm run e2e -w clients/desktop` on Windows: the final line has `"orphans": 0` (not `-1`) — PowerShell CIM listing works.
- [ ] The installer no longer contains `resources\app.asar.unpacked\node_modules\@anthropic-ai\claude-agent-sdk-*` and is ~200 MB smaller; the app still starts sessions.
- [ ] Sandboxed renderer on Windows: Monaco diff renders, Ctrl+C/V in the composer, drag-resizing panes, links in chat open the browser.

Terminal chat (preview) and the shell panel — PROTOCOL §57.17 (Stage 3). What CI already proves on windows-latest: node-pty's
prebuild loads under Electron 44 and in the installed app (`--rg-pty-selftest`, ConPTY with its bundled `conpty.dll`); the
installer ships node-pty unpacked with only what it needs; a fake claude (npm's `claude.cmd` + `cli.js`, run under node.exe,
never through cmd.exe) drives a review turn through ConPTY in vitest (`terminalChat.pty.test.ts`: banner, Write → review,
the git guard, a rejected file's context, resize, 한글 bytes, ESC CR, /exit, resume, no orphans) and in a hidden Electron
window over the real IPC (`npm run e2e:terminal`: the page cannot get `terminal_spec`, a shell tab starts in the project,
no child left — OpenConsole counted; IME composition through CDP and Ctrl+` once the page has its terminal). Turn on
Settings › Session › "Terminal chat (preview)" for the items below.
- [ ] Korean IME (Microsoft 한국어 IME / TSF) in a terminal chat: composing mid-line; Enter, Esc, Ctrl+C, arrows and
      Backspace while composing; Hanja conversion and where the candidate window sits; a composition committed when the
      terminal loses focus. (CI's CDP composition proves the xterm → PTY UTF-8 path, not TSF.)
- [ ] Real `claude.exe` (native installer) and an npm install (`claude.cmd` + `cli.js`, node.exe on PATH; without node the
      chat says "Terminal chat needs the native Claude Code (claude.exe) or Node on PATH"): the trust dialog, a permission
      wait → the strip, the notification and the taskbar; Esc → "Review now"; `/clear` and `/resume` followed; Alt+V image
      paste; Shift+Enter is a newline; the mouse in fullscreen mode; OSC 52 copy on select; rendering with and without
      "Repaint the whole screen each frame"; WebGL on a real GPU and over Remote Desktop (and Off).
- [ ] Menu shortcuts stay out of the TUI while the terminal has the keyboard: Ctrl+B, R, O, P, N, T reach Claude Code;
      Alt+letter does not open a menu; Ctrl+` on Korean, US and European layouts; AltGr characters.
- [ ] No orphans with real children (MCP servers, Bash through Git Bash): Task Manager shows no `claude.exe`, `node.exe`,
      `bash.exe` or `OpenConsole.exe` left after switching chats, closing the window and quitting.
- [ ] The shell panel: PowerShell 7 (`pwsh`) and Windows PowerShell 5.1 with the user's profiles, Command Prompt; tabs keep
      running while hidden; display scaling at 125 % / 150 %; High Contrast.
- [ ] The first PTY spawn under SmartScreen and Defender; no firewall prompt (the hook server binds 127.0.0.1).
- [ ] Windows 10 1903–22H2 and Windows 11; Windows 10 1809 shows the switch disabled with "Terminal chat needs Windows 10
      1903 or later".
- [ ] A long `--settings` / `--mcp-config` once Stage 2 adds flags: the 30,000-character guard refuses with "The command
      line for Claude Code is too long for Windows" rather than failing in CreateProcess.

Updating — PROTOCOL §48 "Windows". What CI proves: download + verify of a fake release served from 127.0.0.1 (redirect,
cap, checksum, PE header) on windows-latest, the steps and the installer's argv in vitest. Needs a real Windows machine
with an older release installed (e.g. 0.5.17 per user) and a newer one published with its installer and `.sha256`:
- [ ] The banner: [Install and Restart] → "Downloading … / … MB" with the bar moving → "Checking the download's
      checksum…" → "Ready — ReviewGate closes and reopens as X" → the windows close, and within ~30 s ReviewGate reopens
      as X (Help shows X) with "Updated to ReviewGate X" and [What's New]; the windows that were open are back.
- [ ] With Claude working in a window: "… is ready. Claude is working — …", the window's button brings it forward,
      the restart happens by itself when the turn ends; [Restart Now] asks first; [Cancel] removes
      `%APPDATA%\ReviewGate\updates\…`.
- [ ] **SmartScreen / Defender on the silent install.** The app writes the installer itself (no browser), so no
      Mark-of-the-Web (`Zone.Identifier`) is expected and SmartScreen should not ask — unverified: note whether
      SmartScreen, a UAC prompt, or a Defender scan / block appears, and how long the install takes with real-time
      protection on. Check `Get-Item …\ReviewGate-Setup-X.Y.Z.exe -Stream *` before the restart (no `Zone.Identifier`).
- [ ] No UAC prompt for the per-user install; the install folder (also a custom one) and both shortcuts are the same
      afterwards; `%APPDATA%\ReviewGate\settings.json` is untouched apart from the update's two keys, which are gone after
      the relaunch.
- [ ] Running the new installer by hand over the old one (no uninstall) upgrades in place the same way.
- [ ] Behind a proxy (system proxy settings): the download goes through it.
- [ ] **All-users install with UAC.** Install an older release for all users (Program Files, "Anyone who uses this
      computer"): [Install and Restart] → the windows close → the UAC prompt (note whether it comes to the front or only
      flashes in the taskbar) → Yes: ReviewGate reopens as X, **not elevated** (Task Manager › Details › Elevated: No),
      still under Program Files, shortcuts kept → No: ReviewGate reopens as the old version with "… did not install —
      Administrator rights were not given …" and [Try Again]. Also as a standard (non-admin) user: the prompt asks for an
      administrator's password.
- [ ] Failure paths: a release without the `.exe` (Install off, says why); the network cut mid-download (why, [Try
      Again]).
- [ ] Task Manager after the update: no `claude.exe` / `node.exe` left from the old version.

Release notes (the preview's known limits, for the release that ships it)
- Terminal chat on Windows is a **preview**, off by default (Settings › Session); it has not been verified on a real Windows
  machine yet. The shell panel (PowerShell / Command Prompt, Ctrl+`) is on wherever the terminal can run.
- Needs Windows 10 1903 or later, and Claude Code as `claude.exe` (or npm's `cli.js` with Node on PATH).
- Switching to another chat ends the terminal chat's Claude Code (what was typed but not sent is lost); it resumes the same
  conversation when you come back.
- Korean IME inside the terminal follows xterm.js's behaviour; if it misbehaves, keep using the classic chat.
- Request Changes, Find in Chat and the other chat-only items are off in a terminal chat: Claude Code's own TUI does them.

Logs
- `%APPDATA%\ReviewGate\logs\engine-YYYY-MM-DD.log` — every engine `log` event (`[w<id>:level]`) plus main-process lines.
  Help → Logs Folder opens it. `REVIEWGATE_VERBOSE=1` also echoes everything to the console.
- Settings: `%APPDATA%\ReviewGate\settings.json` (Help → Settings File Folder). `main.ts` pins `userData` to
  `<appData>/ReviewGate` so dev runs (`npm run dev`) and the packaged app share the same folder
  (macOS: `~/Library/Application Support/ReviewGate/`).

Reporting an issue
1. Help → Copy Diagnostics → paste into the ticket: versions, log folder, settings, and the last `ReviewState` JSON of the focused window.
2. Attach today's `engine-YYYY-MM-DD.log`.
3. Add the exact prompt / file names and, for git issues, `git config core.autocrlf` and `git status` output.
