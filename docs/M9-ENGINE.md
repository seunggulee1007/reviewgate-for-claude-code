# M9 — `@reviewgate/engine`: the `ReviewEngine` API and how clients embed it

The engine (`engine/`) is the single business-logic core of ReviewGate: session lifecycle around
`@anthropic-ai/claude-agent-sdk`, the review gate (snapshot A/B, accept / reject / revert, notes and
request-changes), HUD accounting, branches, git-init, and PR browsing through `gh`. Every reason
code and message text originates here; clients only render `state` and localize.

The wire contract (commands, events, `ReviewState`, semantics) is `docs/PROTOCOL.md` (protocol v2);
the TypeScript source of truth is `engine/src/protocol.ts`. This document covers the in-process API
and the two ways a client attaches to it.

## 1. Public surface

```ts
import { ReviewEngine, createPlatform, type EngineCommand, type EngineEvent, type ReviewState } from "@reviewgate/engine";

type EngineOptions = {
  platform?: Platform;                                   // default createPlatform(process.platform)
  env?: Record<string, string>;                          // base env for every child process; hello.env is merged over it
  log?: (level: LogLevel, msg: string) => void;          // free-form diagnostics (never on the wire)
  sessionFactory?: (opts: ClaudeSessionOptions) => ClaudeSessionLike;   // test seam (FakeClaudeSession)
  now?: () => number;                                    // test seam for hud.turnStartedAt
};

class ReviewEngine {
  constructor(opts?: EngineOptions);
  /** Dispatch one command. Never throws; failures surface as result{ok:false} (if id) and/or error events.
   *  Commands run in order on one lane; pr_* / accounts / login_in_terminal run on their own lane. */
  handle(cmd: EngineCommand): Promise<void>;
  /** In-process convenience: assigns an id, resolves with the typed reply (ready | file_diff |
   *  full_file_content | result) or rejects if the engine is disposed first. */
  request<C extends EngineCommand>(cmd: C): Promise<ReplyFor<C>>;
  /** Subscribe to every event (state snapshots, replies, transcript events). Returns the unsubscribe. */
  on(listener: (ev: EngineEvent) => void): () => void;
  /** Last emitted snapshot (a pending coalesced emission is flushed first). */
  get state(): ReviewState;
  /** close_project + stop the CLI (abort → SIGKILL after 1 s, ≤ 2.5 s total), one final state, then no more events. */
  dispose(): Promise<void>;
}
```

- `hello` must be the first command; it answers `ready` and the initial `state` (`seq` 1).
- `state` is derived from internal slices by `buildState` (`engine/src/state.ts`) and emitted once per
  macrotask after any mutation (`setImmediate` coalescing); `seq` strictly increases, so clients may drop
  out-of-order snapshots.
- `ENGINE_VERSION` / `PROTOCOL_VERSION` are exported; `ready.engineVersion` carries the former.
- Lower-level pieces are exported too (for tests and tooling): `GitCheckpoint`, `branches`, `matchesIgnore`,
  `parseUnifiedDiff`, `deriveFullFile`, `GHClient`, `PRStore`, `ClaudeSession`, `buildHooks`,
  `createPlatform`, `locateToolchain`. A client should not need them.

## 2. Internal layout

| Module | Owns |
|---|---|
| `engine.ts` | command dispatch, id correlation, lanes, state coalescing, toolchain location, session lifecycle, HUD accounting |
| `state.ts` | `buildState()`, `canSend` / `blockedReason` / `canRequestChanges` / `switchBlocker` derivation |
| `review/gate.ts`, `review/notes.ts` | phases, snapshot A/B, accept / reject / revert, notes, request-changes (kept A + accepted-patch hashes), diff cache |
| `git/exec.ts`, `git/checkpoint.ts`, `git/branches.ts`, `git/ignore.ts`, `git/repo.ts` | `git` with `-c core.quotepath=off`, temp-index snapshots (`-z` parsing), restore with blob fallback, branches, ignore globs, git-init candidates |
| `diff/parse.ts`, `diff/fullfile.ts` | unified diff → `FileDiff` (line numbers 1-based, 20k-line cap), `full_file_content` derivation (20k lines / 2 MB) |
| `pr/gh.ts`, `pr/auth.ts`, `pr/store.ts`, `pr/models.ts` | `gh api` (paginate, stdin bodies, 90 s timeout), `hosts.yml` + per-host 8 s `auth status`, PR lists / detail / drafts / submit / reply |
| `session/claude.ts`, `session/hooks.ts`, `session/budget.ts`, `session/queue.ts` | the SDK query driver, PreToolUse budget / ask / git-guard hooks, per-turn budget |
| `platform/{darwin,win32,linux}.ts`, `platform/toolchain.ts` | `which`, `openTerminal`, `killTree`, `ghConfigDir`; `claude` / `gh` / `git` location with overrides |

Cross-platform rules (temp index in `os.tmpdir()`, `LC_ALL=C`, Buffer stdout decoded after NUL split,
`.cmd` shim handling for `claude` on Windows, `taskkill /T` kill tree) are listed in `docs/M9-PLAN.md` §2.

## 3. Embedding

### 3.1 Out of process — the Mac app (today)

`sidecar/src/index.ts` (~70 lines) is the only process-bound code: it bundles the engine with esbuild
into `sidecar/dist/sidecar.mjs`, reads NDJSON commands from stdin, writes every `EngineEvent` as one
JSON line to stdout, and treats stdin EOF / `shutdown` / parent death / EPIPE as `engine.dispose()`
followed by exit. A first line that is not `hello` yields `error{fatal:true}` and exit code 2.

On the Swift side `Core/Sources/ReviewGateCore/Engine/` mirrors the contract: `EngineProtocol.swift`
(Codable commands / events / `ReviewState`, decode-tested against the goldens in
`engine/test/fixtures/wire/`), `EngineTransport.swift` (the `node sidecar.mjs` process, line reader,
SIGPIPE-safe writes, graceful stop), `EngineClient.swift` (`hello`/`ready`, id-correlated `request`,
respawn with `hello` + `set_settings` replay), and `Session/AppState.swift` / `Session/PRStore.swift`
(`@Observable` mirrors of `state` plus the transcript). `ToolchainLocator.swift` only finds `node` and
the login-shell PATH; the engine locates everything else.

### 3.2 In process — the Electron client (M10)

Electron has Node in the main process, so the engine runs there with no sidecar and no stdio:

```ts
// src/main/main.ts
import { app, BrowserWindow, ipcMain } from "electron";
import { ReviewEngine, createPlatform } from "@reviewgate/engine";

const engine = new ReviewEngine({
  platform: createPlatform("win32"),
  env: process.env as Record<string, string>,
  log: (level, msg) => console.error(`[engine:${level}] ${msg}`),
});

app.whenReady().then(() => {
  const win = new BrowserWindow({ webPreferences: { preload: PRELOAD } });
  engine.on((ev) => win.webContents.send("rg:evt", ev));       // every EngineEvent → renderer
  ipcMain.on("rg:cmd", (_e, cmd) => void engine.handle(cmd));  // renderer → engine
  ipcMain.handle("rg:request", (_e, cmd) => engine.request(cmd));
  void engine.handle({ type: "hello", protocolVersion: 2, client: "windows", settings: loadSettings() });
});
app.on("before-quit", (e) => { e.preventDefault(); void engine.dispose().then(() => app.exit(0)); });
```

```ts
// src/preload.ts
contextBridge.exposeInMainWorld("rg", {
  send: (cmd) => ipcRenderer.send("rg:cmd", cmd),
  request: (cmd) => ipcRenderer.invoke("rg:request", cmd),
  onEvent: (cb) => ipcRenderer.on("rg:evt", (_e, ev) => cb(ev)),
});
```

The renderer keeps the same client-side state the Swift `AppState` keeps (last `state`, transcript
built from `user_message` / `text_delta` / `tool_use` / `tool_result` / `permission_request` /
`budget_event` / `turn_end` / `error`, selection, cached `file_diff` / `full_file_content`), and sends
the same commands. `sidecar/test/driver-v2.mjs` is the conformance script both clients must pass; the
Electron client can run it against the in-process engine by importing `@reviewgate/engine` directly.

Windows-specific behaviour (`.cmd` shims, `where.exe`, `%APPDATA%\GitHub CLI\hosts.yml`,
`taskkill /T`, `core.longpaths`) lives in `platform/win32.ts` and `platform/toolchain.ts` and needs a
real Windows machine for verification (`docs/M9-PLAN.md` §6).

## 4. Tests

- `npm test -w engine` — vitest (`engine/test/*.test.ts`): git checkpoint / branches / ignore / repo,
  diff parse / full-file, gh decode + auth (fake `gh` script), PR store, review gate through
  `ReviewEngine` with `FakeClaudeSession`, protocol goldens, platform, exec.
- `npm test -w sidecar` — `node --test sidecar/test/adapter.test.mjs`: hello/ready/state/shutdown, stdin
  EOF, closed-gate `result`, first-message guard (exit 2), non-JSON input.
- `swift test --package-path Core` — protocol decode against the goldens, `EngineTransport` process
  handling, toolchain probe parsing, settings persistence, syntax highlighter.
- `node sidecar/test/driver-v2.mjs` — engine-level E2E with a real `claude` (opens a project, one turn,
  reject / request_changes / accept, branches, shutdown; asserts no orphaned processes).
