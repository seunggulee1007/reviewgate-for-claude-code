# M9 — Engine extraction: TypeScript `engine/` as the single business-logic core, Swift and Electron as thin protocol clients

## 0. Current state (what I found)

- **Swift Core** (`Core/Sources/ReviewGateCore`, ~3.9k lines) holds all logic: `SessionStore.swift` (918 lines: session lifecycle, review gate, request-changes, HUD, branches), `Git/GitCheckpoint.swift` (temp-index snapshot, `-z` numstat/name-status, revert with `writeBlob` fallback), `Git/GitBranches.swift`, `Git/CheckpointIgnore.swift` (`fnmatch`), `PR/GHClient.swift` + `PR/PRStore.swift` + `PR/GHAuth.swift` (gh CLI, hosts.yml, osascript Terminal login), `Diff/UnifiedDiffParser.swift`, `Diff/FullFileView.swift`, `Diff/SyntaxHighlighter.swift` (Highlightr), `Sidecar/SidecarClient.swift` (actor over Process/NDJSON, solid), `Sidecar/SidecarProtocol.swift` (v1 Codable), `Sidecar/ToolchainLocator.swift` (`zsh -lic` probe for node/claude), `Session/AppSettings.swift` (UserDefaults).
- **Sidecar** (`sidecar/src`, 1.3k lines): `index.ts` is a module-global, process-bound query driver (`emit` = `process.stdout.write`, `shutdown` = `process.exit`); `hooks.ts` (budget/ask/git-guard hooks, already runs `git` via `execFile` with `core.quotepath=off` and `tmpdir()` temp index); `budget.ts` (already has a TS `matchesIgnore` mirror of `CheckpointIgnore`); `protocol.ts` v1.
- **App** views consume `SessionStore` (12 property/method groups) and `PRStore` (PR views + Accounts settings). All AX identifiers used by the scratchpad E2E scripts (`e2e.sh`, `m2e2e.sh`, `m3e2e.sh`, `m6.sh`, `review.applescript`, `send.applescript`, `ax7/ax8` drivers) are on views, not on Core — they survive the refactor untouched.
- Build: `project.yml` pre-build script runs `cd sidecar && npm ci && npm run build` → `sidecar/dist/sidecar.mjs`, embedded at `Resources/dist/sidecar.mjs`. Keeping that filename and location means no `project.yml` change.

---

## 1. Inventory: what moves, what stays, what is deleted

| Swift Core file | Decision | Rationale / notes |
|---|---|---|
| `Session/SessionStore.swift` | **Move** → `engine/src/review/gate.ts` + `engine/src/engine.ts`; Swift replaced by `Session/AppState.swift` (thin mirror) | All gate semantics (snapshot A/B, accept/reject/revert, request-changes with kept A + patch-hash pre-accept, collect-failed retry, HUD accounting, activity) become engine logic. Swift keeps only transcript accumulation, selection, and localization of reason codes. |
| `Git/GitCheckpoint.swift` | **Move** → `engine/src/git/checkpoint.ts`; **delete** Swift | Port 1:1 including `-z` parsing of numstat/name-status, rename pairing, `restore --source` with `cat-file` blob fallback, empty-parent pruning. `ChangedFile`/`ChangeStatus`/`ReviewState` become wire types (Swift keeps Decodable structs in `Engine/EngineProtocol.swift`). |
| `Git/GitBranches.swift` | **Move** → `engine/src/git/branches.ts`; **delete** Swift | `for-each-ref` with `%00`, `parseTrack`, `check-ref-format`, `switch`, `switch -c`. `BranchInfo`/`BranchSwitchBlocker` become wire types. |
| `Git/CheckpointIgnore.swift` | **Move** → `engine/src/git/ignore.ts` (promote existing `matchesIgnore` from `sidecar/src/budget.ts`); **delete** Swift | One implementation for both budget numstat and review list. `fnmatch` replaced by the existing `*`→`.*` regex (same semantics as today's TS mirror). `parse()` (one-per-line) stays in Swift `AppSettings` because the Settings TextEditor stores raw text; engine receives the parsed array. |
| `Git/CommandRunner.swift` | **Keep (shrunk)** | Only `ToolchainLocator` (node probe) still needs it. Drop `stdin`/`timeout` variants if unused after step 4. |
| `Session/ChatItem.swift` | **Keep** | Pure view model for the transcript. |
| `Session/AppSettings.swift` | **Keep** | Persistence is per client (UserDefaults). Add `func enginePayload() -> Settings` building the `set_settings` message. `cachedCapabilities`, `recentProjects` stay client-side. |
| `Sidecar/ToolchainLocator.swift` | **Keep, shrink to node + loginPATH** | Swift must find `node` to launch the engine. `claude`/`gh`/`git` resolution moves to `engine/src/platform/toolchain.ts` (engine receives `env.PATH` from the client and optional overrides). `Toolchain.claudeVersion()` becomes a read of `state.toolchain.claudeVersion`. |
| `Sidecar/SidecarClient.swift` | **Keep, rename `EngineTransport`** | The LineReader/termination/SIGPIPE work is exactly what v2 needs. Only the decoded type changes (`ServerMessage` → `EngineEvent`). |
| `Sidecar/SidecarProtocol.swift` | **Replace** by `Engine/EngineProtocol.swift` (v2) | v1 enum deleted in step 4. `Budget`, `Usage`, `PermissionRequest`, `BudgetUsage`, `LogLevel`, `ActivityKind` carry over. |
| `Sidecar/JSONValue.swift` | **Keep** (move to `Engine/`) | Tool inputs. |
| `PR/GHClient.swift` | **Move** → `engine/src/pr/gh.ts`; **delete** Swift | `gh api --hostname`, `--paginate --slurp` page flattening, `--input -` stdin bodies, 90s timeout. |
| `PR/GHAuth.swift` | **Move** → `engine/src/pr/auth.ts`; **delete** Swift | hosts.yml parse (path differs on Windows: `%APPDATA%\GitHub CLI\hosts.yml`), per-host 8s probe, `--json hosts` parse. `openLoginInTerminal` → `platform.openTerminal(command)`. |
| `PR/PRStore.swift` | **Move** → `engine/src/pr/store.ts`; Swift replaced by thin `Session/PRStore.swift` mirror (same name, same public API so PR views do not change) | |
| `PR/PRModels.swift` | **Keep** (already Codable) + add `GHAccount`, `SubmitResult` here | Dates decode ISO-8601 from the wire. `DraftComment.id` becomes a string (engine-generated) — `UUID` → `String`, `id: UUID = UUID()` init kept for the composer via `UUID().uuidString`. |
| `Diff/UnifiedDiffParser.swift` | **Move** → `engine/src/diff/parse.ts`; **delete** Swift | Decision: move. (1) Both clients need identical line numbering for notes/comments; (2) PR patches from `gh` never need to cross the wire raw; (3) the parser is 124 lines with 12 tests that port mechanically; (4) `FileDiff` JSON is ~2–3x the patch text, and per-turn diffs are budget-bounded (≤ ~300 lines). For PR files the engine caps at 20k lines (`truncated: true`). Swift keeps `DiffModels.swift` as Decodable structs only. |
| `Diff/FullFileView.swift` | **Move derivation** → `engine/src/diff/fullfile.ts`; Swift keeps the struct (Decodable) | The struct's `init(path:content:diff:)` derivation is deleted; `full_file_content` carries `lines`, `changedNewLines`, `deletedAfterNewLine`, plus `oldText`/`newText` for Monaco. |
| `Diff/DiffModels.swift` | **Keep** + `Decodable` | `DiffLineKind` gets `String` raw values `"context"|"add"|"del"|"hunkHeader"`. |
| `Diff/SyntaxHighlighter.swift` | **Keep** | View support; Monaco highlights on Windows. |
| `App/UI/Diff/ExternalEditor.swift` | **Keep** (client concern) | Electron uses `shell.openPath` / `code -g`. |
| Tests | Delete `GitCheckpointTests`, `GitBranchesTests`, `CheckpointIgnoreTests`, `GHClientTests`, `GHAuthTests`, `RequestChangesTests`, `SessionStoreTests`, `SidecarProtocolTests` (v1 part), `UnifiedDiffParserTests`, `FullFileViewTests`; port to vitest. Keep `SidecarClientTests` (transport), `SyntaxHighlighterTests`, `ProjectSettingsTests` (recent-projects test only; git-candidates/unsafe tests port to TS). Add `EngineProtocolTests` (decode fixture `state`/`file_diff` JSON produced by the TS test suite and checked into `engine/test/fixtures/wire/`). |

Sidecar files: `budget.ts`, `hooks.ts`, `queue.ts` move under `engine/src/session/`; `sidecar/src/index.ts` is rewritten as a ~120-line stdio adapter; `sidecar/src/protocol.ts` is replaced by a re-export of `@reviewgate/engine` types.

---

## 2. Engine package layout

Root becomes an npm workspace so sidecar and the Electron client both depend on the engine by symlink (esbuild bundles it in; no publish step).

```
./
  package.json                      # { "private": true, "workspaces": ["engine", "sidecar", "clients/*"] }
  engine/
    package.json                    # name "@reviewgate/engine", type module, main src/index.ts (consumed via bundlers), scripts: test=vitest, typecheck=tsc
    tsconfig.json                   # ES2022 / NodeNext / strict, same as sidecar
    vitest.config.ts                # pool: "forks" (git subprocess tests), testTimeout 20s
    src/
      index.ts                      # export { ReviewEngine } + all protocol types
      engine.ts                     # ReviewEngine: command dispatch, state assembly, coalesced `state` emission, id correlation
      protocol.ts                   # v2 wire types (section 3)
      state.ts                      # buildState(): derives gate.canSend/blockedReason/switchBlocker; ReviewState is always computed from internal slices
      review/gate.ts                # ReviewGate: phases + accept/reject/notes/requestChanges/collect/retry; owns turnStartTree/turnEndTree, acceptedPatchHashes, diff cache
      review/notes.ts               # ReviewNote list, requestChangesMessage(notes, extra) (byte-identical to SessionStore.requestChangesMessage)
      git/exec.ts                   # runGit(root, args, {env, stdin, binary}): prepends -C root -c core.quotepath=off (+ -c core.longpaths=true on win32), LC_ALL=C, 64MB maxBuffer, Buffer stdout, nulSplit()
      git/checkpoint.ts             # openCheckpoint(dir) | initRepository | snapshot | changes | patch | revert | fileContent | branchName | remoteURL
      git/branches.ts               # branches | isWorktreeDirty | switchBranch | createBranch | parseTrack
      git/ignore.ts                 # matchesIgnore (from sidecar/budget.ts)
      git/repo.ts                   # findGitCandidates(dir), looksUnsafeForGitInit(dir, home)
      diff/parse.ts                 # parseUnifiedDiff(patch): FileDiff
      diff/fullfile.ts              # deriveFullFile(path, newBytes, diff, isBinary): FullFileView (limits 20k lines / 2MB)
      pr/gh.ts                      # GHClient(ghPath, host, env): search/detail/files/comments/reviews/submitReview/reply + decodePages
      pr/auth.ts                    # ghConfigDir(platform), parseHostsYAML, status(ghPath, env) with per-host 8s timeout, loginCommand(host)
      pr/store.ts                   # PRStore: host, lists, open, selectFile (parses patch), drafts, submit, reply, accounts
      session/claude.ts             # ClaudeSession class: everything in today's sidecar/index.ts minus process I/O (start/sendUser/interrupt/respondPermission/setBudget/stop), emits typed events
      session/hooks.ts              # from sidecar/hooks.ts (uses git/exec.ts + git/ignore.ts)
      session/budget.ts             # from sidecar/budget.ts minus matchesIgnore
      session/queue.ts
      platform/index.ts             # Platform interface + createPlatform(process.platform)
      platform/darwin.ts            # openTerminal via osascript; which via login-shell probe (`zsh -lic`); killTree = SIGKILL
      platform/win32.ts             # openTerminal = spawn("cmd", ["/c","start","cmd","/k",command], {detached, windowsHide:false}); which via `where.exe` + known dirs; killTree = `taskkill /pid N /T /F`
      platform/linux.ts             # x-terminal-emulator fallback (unused for now, trivial)
      platform/toolchain.ts         # locateToolchain(platform, env, overrides): {claude, gh, git, claudeVersion, ghVersion, gitVersion}
      util/exec.ts                  # execFile wrapper: timeout→kill, maxBuffer, stdin Buffer, returns {stdout:Buffer, stderr:string, status, signal}
    test/
      helpers/repo.ts               # makeRepo(): temp git repo with the same fixture files as GitCheckpointTests.makeRepo (README.md, other.txt, tomove.txt, untracked.txt), user.name/email, autocrlf=false
      git.checkpoint.test.ts        # port of GitCheckpointTests (6 tests incl. index-fingerprint invariance, writeBlob fallback, exec-bit — exec-bit test skipped on win32)
      git.branches.test.ts          # port of GitBranchesTests (3)
      git.ignore.test.ts, git.repo.test.ts
      diff.parse.test.ts            # port of UnifiedDiffParserTests (12)
      diff.fullfile.test.ts         # port of FullFileViewTests (3)
      pr.gh.test.ts                 # port of GHClientTests decode/encode (10) using fixtures/gh/*.json; live test gated by GH_LIVE=1
      pr.auth.test.ts               # port of GHAuthTests (7) incl. hung-gh timeout using a fake `gh` script (sh on posix, .cmd on win32)
      review.gate.test.ts           # port of RequestChangesTests (2) + SessionStoreTests activity/capabilities (2), driven through ReviewEngine with a FakeClaudeSession
      engine.protocol.test.ts       # golden `state`/`file_diff`/`full_file_content` JSON written to test/fixtures/wire/ (consumed by Swift EngineProtocolTests)
      session.budget.test.ts        # moved sidecar/src/budget.test.ts
  sidecar/
    package.json                    # depends on "@reviewgate/engine": "*"; build = esbuild src/index.ts → dist/sidecar.mjs (unchanged output path)
    src/index.ts                    # stdio adapter (~120 lines): readline → engine.handle(); engine.on("event") → stdout NDJSON; stdin EOF → engine.dispose() → exitAfterFlush; watchParent only on darwin/linux
```

`Makefile`/`project.yml` pre-build script change: `cd "$SRCROOT" && npm ci --omit=optional && npm run build -w sidecar` (workspace install from root). Output path is unchanged.

### `ReviewEngine` public surface (`engine/src/engine.ts`)

```ts
export type EngineOptions = {
  platform?: Platform;                    // default createPlatform(process.platform)
  env?: Record<string, string>;           // base env for every child process (PATH from the client)
  log?: (level: LogLevel, msg: string) => void;
  sessionFactory?: (opts) => ClaudeSessionLike;   // test seam (FakeClaudeSession)
};

export class ReviewEngine {
  constructor(opts?: EngineOptions);
  /** Dispatch one command. Never throws; failures surface as `result{ok:false}` (if id) and/or `error` events. */
  handle(cmd: EngineCommand): Promise<void>;
  /** In-process convenience (Electron): assigns an id, resolves with the typed reply or rejects. */
  request<C extends EngineCommand>(cmd: Omit<C, "id">): Promise<ReplyFor<C>>;
  on(listener: (ev: EngineEvent) => void): () => void;   // unsubscribe
  get state(): ReviewState;                               // last emitted snapshot
  dispose(): Promise<void>;                               // close_project + stop children (≤2.5s), then no more events
}
```

Internal slices owned by the engine: `project` (checkpoint, info, gitInit), `session` (ClaudeSession + capabilities/HUD accounting), `gate` (ReviewGate), `pr` (PRStore), `settings`. Any mutation calls `this.touch()`, which schedules one `state` emission on the next macrotask (`setImmediate`), so a burst (turn_end → collect → branches refresh) yields a handful of snapshots, not dozens.

### Cross-platform rules baked into `git/exec.ts` and `platform/*`

- Executable resolution: `platform.which(name)` — darwin: login-shell probe once per engine (`zsh -lic 'command -v claude; command -v gh; command -v git; printf "%s\n" "$PATH"'`, reusing today's noise-tolerant parser), then fallbacks (`~/.local/bin/claude`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin/git`); win32: `where.exe name` then `%USERPROFILE%\.local\bin\claude.exe`, `%APPDATA%\npm\claude.cmd`, `C:\Program Files\GitHub CLI\gh.exe`, `C:\Program Files\Git\cmd\git.exe`. Always spawn with the resolved absolute path; never `shell: true`.
- `.cmd` shims (npm-installed `claude.cmd`): `session/claude.ts` detects the `.cmd` extension, reads the sibling `node_modules/@anthropic-ai/claude-code/cli.js` and spawns `process.execPath cli.js` (`ELECTRON_RUN_AS_NODE=1` when running inside Electron). Native `claude.exe` is spawned directly.
- `git rev-parse --show-toplevel` on Windows prints `C:/Users/x/repo`; the engine keeps `root` in git form (forward slashes) for git args and repo-relative joins, and uses `path.normalize(root + "/" + rel)` only for `fs` calls. Repo-relative paths on the wire are always `/`-separated (git's own output form).
- `-z` everywhere it exists (`diff-tree --name-status/--numstat`, `ls-tree`), `core.quotepath=off`, `LC_ALL=C`; stdout read as `Buffer`, decoded UTF-8 after NUL split, so non-ASCII (Korean) filenames survive on both platforms.
- Temp index: `path.join(os.tmpdir(), "rg-index-<uuid>")`; `GIT_INDEX_FILE` set in the child env; `.lock` removed in `finally`. Retry `EBUSY`/`EPERM` once after 100ms on win32 (Defender file locks).
- CRLF: git normalizes according to the repo's `core.autocrlf`/`.gitattributes` at `add -A` time, so both snapshot trees are normalized the same way and diffs are line-accurate; `revert` (`git restore --source`) rewrites with the repo's line-ending policy. Engine does not touch line endings itself. `full_file_content` splits on `\r?\n`.
- Executable bit: `writeBlob` fallback applies `chmod 755/644` only on posix.
- Parent-death watchdog: darwin/linux only (`process.ppid === 1`); on win32 stdin EOF is the signal. Child kill: `platform.killTree(pid)`.
- Terminal login: `platform.openTerminal("gh auth login --hostname H --web --git-protocol https")` — host validated by the same regex as today before it is interpolated.
- gh config dir: `GH_CONFIG_DIR` → else win32 `%APPDATA%\GitHub CLI` → else `~/.config/gh`.

---

## 3. Protocol v2 (`docs/PROTOCOL.md` rewrite)

Transport: NDJSON over stdio (Mac) or the same objects over Electron IPC. `type` discriminator. Commands may carry `id: string`; **every command with an `id` gets exactly one reply carrying that `id`**: the typed reply listed for it, else `result`. Commands without `id` get no reply (state changes still arrive via `state`).

### 3.1 App → Engine commands

```ts
type Cmd<T extends string, P = {}> = { type: T; id?: string } & P;

type Settings = {
  budget: Budget;                          // {maxFiles, maxLines, hardMultiplier?}
  ignorePatterns: string[];                // parsed, one entry per pattern
  autoAllowTools: string[];                // e.g. ["Bash"]
  loadUserSettings: boolean;
  systemPromptAppend: string;              // already rendered ({maxFiles}/{maxLines} substituted by the client)
  claudePath?: string; ghPath?: string; gitPath?: string;   // overrides
  ghHost: string;                          // PR browser host
  model?: string;
};

type EngineCommand =
  | Cmd<"hello", { protocolVersion: 2; client: "mac" | "windows" | "test"; env?: Record<string,string>; settings: Settings }>   // → ready
  | Cmd<"set_settings", { settings: Partial<Settings> }>       // budget applies live; others on next open_project
  | Cmd<"open_project", { path: string }>                      // closes current if any; → state (project | gitInit)
  | Cmd<"switch_project", { path: string }>                    // alias of open_project (caller confirmed pending review)
  | Cmd<"close_project">
  | Cmd<"init_repo">                                           // when state.gitInit.needed
  | Cmd<"cancel_git_init">
  | Cmd<"send", { text: string }>                              // guarded by gate.canSend; engine prefixes lastReviewSummary
  | Cmd<"request_changes", { extra?: string }>                 // guarded by gate.canRequestChanges
  | Cmd<"interrupt">
  | Cmd<"permission_response", { requestId: string; allow: boolean; message?: string; updatedInput?: object }>
  | Cmd<"accept", { paths: string[] }> | Cmd<"accept_all">
  | Cmd<"reject", { paths: string[] }> | Cmd<"reject_all">    // reverts on disk, re-snapshots B
  | Cmd<"retry_collect">
  | Cmd<"add_note", { path: string; line: number | null; side: "old" | "new"; excerpt: string; body: string }>
  | Cmd<"remove_note", { noteId: string }>
  | Cmd<"select_file", { path: string }>                       // → file_diff (cached per turn)
  | Cmd<"full_file", { path: string }>                         // → full_file_content
  | Cmd<"branches">                                            // refresh → state.branches (+ result)
  | Cmd<"switch_branch", { name: string }> | Cmd<"create_branch", { name: string; from?: string }>
  | Cmd<"pr_list">                                             // refresh mine + reviewRequested
  | Cmd<"pr_open", { summaryId: string }>                      // "host/owner/repo#N"
  | Cmd<"pr_close">
  | Cmd<"pr_select_file", { filename: string }>                // → file_diff {scope:"pr"}
  | Cmd<"pr_add_draft", { path: string; line: number; side: "LEFT" | "RIGHT"; startLine?: number; body: string }>
  | Cmd<"pr_remove_draft", { draftId: string }>
  | Cmd<"pr_submit", { event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; body: string }>
  | Cmd<"pr_reply", { commentId: number; body: string }>
  | Cmd<"pr_reload_comments">
  | Cmd<"accounts">                                            // gh auth status → state.pr.accounts
  | Cmd<"login_in_terminal", { host: string }>
  | Cmd<"shutdown">;
```

### 3.2 Engine → App

One **snapshot** message plus streaming events.

```ts
type ReviewState = {
  seq: number;                                   // monotonic; clients drop out-of-order
  project: null | { path: string; root: string; name: string; branch: string | null; remoteURL: string | null };
  gitInit: null | { path: string; candidates: string[]; looksUnsafe: boolean };
  session: {
    open: boolean; starting: boolean;
    sessionId: string | null; model: string | null;
    capabilities: { slashCommands: string[]; skills: string[]; plugins: string[]; mcpServers: {name: string; status: string}[] } | null;
    pendingPermission: PermissionRequest | null;
  };
  toolchain: { claude: string | null; gh: string | null; git: string | null; claudeVersion: string | null; ghVersion: string | null };
  gate: {
    phase: "idle" | "starting" | "running" | "collecting" | "collect_failed" | "reverting" | "reviewing";
    canSend: boolean; canRequestChanges: boolean;
    blockedReason: null | "git_init_needed" | "no_session" | "starting" | "running" | "awaiting_permission"
                 | "collecting" | "reverting" | "collect_failed" | "pending_review" | "changes_requested";
    collectError: string | null;
    pendingCount: number; changesRequestedCount: number;
    isRequestingChanges: boolean;
    turnStartTree: string | null; turnEndTree: string | null;
    lastReviewSummary: string | null;            // the "[Review gate] Accepted: …" prefix that the next send will use
  };
  changedFiles: ChangedFile[];                   // {path, oldPath, status:"A"|"M"|"D"|"R"|"X", added, deleted, isBinary, tools[], state:"pending"|"accepted"|"rejected"|"changesRequested", noteCount}
  reviewNotes: ReviewNote[];                     // {id, path, line, side, excerpt, body}
  budget: Budget; budgetUsage: { files: number; lines: number; denied: boolean };
  hud: { contextTokens: number; contextWindow: number | null; sessionCostUSD: number; turnCount: number; lastTurnMs: number;
         activity: { kind: "idle" | "working" | "thinking" | "tool" | "subagent"; toolName?: string; detail?: string };
         subagentDepth: number; turnStartedAt: number | null /* epoch ms */ };
  branches: { list: BranchInfo[]; isWorktreeDirty: boolean;
              switchBlocker: null | { kind: "pendingReview"; count: number } | { kind: "dirtyWorktree" } | { kind: "running" } };
  pr: {
    host: string;
    mine: PRSummary[]; reviewRequested: PRSummary[];
    selectedSummary: PRSummary | null; selected: PRDetail | null;
    files: PRFileMeta[];                          // PRFile WITHOUT `patch` (engine keeps patches; see pr_select_file)
    comments: PRComment[]; reviews: PRReview[];
    draftComments: DraftComment[];                // id: string
    accounts: GHAccount[];
    isLoading: boolean; isSubmitting: boolean; errorText: string | null;
    lastSubmitResult: { reviewURL: string; inlineCount: number; event: ReviewEvent; submittedAt: string } | null;
  };
  lastError: string | null;
};

type EngineEvent =
  | { type: "ready"; id?: string; engineVersion: string; platform: "darwin" | "win32" | "linux"; protocolVersion: 2 }
  | { type: "state"; state: ReviewState }
  | { type: "result"; id: string; ok: true } | { type: "result"; id: string; ok: false; error: string }
  | { type: "file_diff"; id?: string; scope: "turn" | "pr"; path: string; diff: FileDiff; truncated: boolean }
  | { type: "full_file_content"; id?: string; path: string; lines: string[]; changedNewLines: number[];
      deletedAfterNewLine: Record<string, string[]>; isBinary: boolean; isTooLarge: boolean;
      oldText: string | null; newText: string | null }          // old/new for Monaco DiffEditor; null when binary/too large
  | { type: "user_message"; text: string; turn: number }        // what the engine actually queued (send prefix / request-changes text) — transcript row
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: object; file?: string }
  | { type: "tool_result"; toolUseId: string; isError: boolean; preview: string }
  | { type: "permission_request"; requestId: string; toolName: string; input: object; file?: string }   // also mirrored in state.session.pendingPermission
  | { type: "budget_event"; kind: "warn" | "deny"; toolName: string; file?: string; files: number; lines: number; budget: Budget }
  | { type: "activity"; kind: "tool_start" | "tool_end" | "subagent_start" | "subagent_end" | "thinking" | "idle"; toolName?: string; detail?: string }  // kept for HUD granularity; state.hud.activity is the folded form
  | { type: "turn_end"; stopReason: string; usage: TurnUsage; files: number; added: number; deleted: number }   // transcript summary row; review list arrives via state
  | { type: "error"; message: string; fatal: boolean; scope: "engine" | "session" | "git" | "pr" }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string };
```

Semantics to write into the doc:
- `hello` must be first; engine answers `ready` then an initial `state`. In stdio mode a first message of `start_session` selects the v1 legacy adapter (step 2 only; removed in step 4).
- `state` is emitted after every mutation, coalesced per macrotask; `seq` strictly increases. Size: bounded by budget (changed files ≤ ~10) and PR metadata (files without patch, comments) — expected 5–80 KB. `state_patch` (RFC 6902) is explicitly deferred; add only if measured > 200 KB or > 20 msg/s.
- `select_file` and `full_file` are pure reads; diff cache invalidates when `gate.turnEndTree` changes, so clients re-request on that change.
- `accept`/`reject` on a non-pending path is a no-op (`result ok:true`); `reject` runs sequentially, each success re-snapshots B; the first failure stops the batch and surfaces `error{scope:"git"}` + `gate.phase` returns to `reviewing`.
- `send` while `!canSend` → `result{ok:false, error:"gate_closed:<blockedReason>"}`; `request_changes` bypasses `canSend` by design (only `canRequestChanges` is checked).
- `turn_end` transcript event fires after collection succeeds (so `files/added/deleted` are known); on collection failure `state.gate.phase = "collect_failed"` and no `turn_end` event until `retry_collect` succeeds.
- Permission `ask`-hook semantics, auto-allowed edit tools, read-only set, `stopReason: "interrupted"`, `loadUserSettings` — carried over verbatim from v1.
- `error{fatal:true, scope:"session"}` = Claude session died; engine keeps running, `session.open=false`, the review list (if any) is preserved; `open_project` again restarts.

Wire dates are ISO-8601 strings; `lastCommitDate` in `BranchInfo` is epoch seconds or null.

---

## 4. Swift client refactor

New/changed files in `Core/Sources/ReviewGateCore/`:

- `Engine/EngineProtocol.swift` — `EngineCommand` (Encodable enum with associated values, `id` slot), `EngineEvent` (Decodable enum), `ReviewState` + nested `Codable` structs (`ProjectInfo`, `GitInitInfo`, `SessionInfo`, `GateInfo`, `ChangedFile`, `ReviewNote`, `HUDWire`, `BranchesInfo`, `PRState`, `Toolchain`), `Budget`, `Usage`, `PermissionRequest`, `BudgetUsage`. `FileDiff`/`DiffHunk`/`DiffLine` gain `Decodable` in `Diff/DiffModels.swift`; `FullFileView` gains `Decodable` (custom init mapping `changedNewLines: [Int]` → `Set<Int>`, `deletedAfterNewLine: [String: [String]]` → `[Int: [String]]`).
- `Engine/EngineClient.swift` — `actor EngineClient`: owns one `EngineTransport` (today's `SidecarClient`, renamed, decoding `EngineEvent`), started lazily at first command with `nodePath` from `ToolchainLocator` and script path `Resources/dist/sidecar.mjs` (or `REVIEWGATE_SIDECAR`). API: `func send(_ cmd: EngineCommand) throws`, `func request(_ cmd: EngineCommand) async throws -> EngineEvent` (assigns UUID id, awaits the matching reply, throws on `result ok:false` or transport exit), `nonisolated let events: AsyncStream<EngineEvent>`, `func stop() async` (sends `shutdown`, then transport stop). On transport exit: pending requests fail, an `error{fatal:true, scope:"engine"}` is yielded, and the next `send` re-spawns the engine and replays `hello` + `set_settings` (project must be reopened by the user; AppState shows the error row).
- `Session/AppState.swift` — `@MainActor @Observable public final class AppState`:
  - Stored: `state: ReviewState` (starts at `.empty`), `transcript: [ChatItem]`, `logs: [String]`, `selectedPathValue: String?`, `selectedDiff: FileDiff?`, `diffCache: [String: FileDiff]`, `toolchainNode: Toolchain?`, `pr: PRStore`.
  - Computed properties **preserving every name views use today**: `projectURL` (from `state.project?.path ?? state.gitInit?.path`), `projectInfo`, `projectName`, `isSessionOpen`, `isRunning` (`gate.phase == .running`), `isStarting`, `isSnapshotting` (`.collecting`), `isReverting`, `reviewCollectFailed` (`gate.collectError`), `changedFiles`, `pendingFiles`, `changesRequestedFiles`, `hasPendingReview`, `canSend`, `canRequestChanges`, `cannotSendReason` (switch on `blockedReason` → the existing localized strings in Core's `Localizable.xcstrings`), `budget`, `budgetUsage`, `sessionId`, `model`, `capabilities`, `isCapabilitiesCached` (true while `state.session.capabilities == nil` and the UserDefaults cache is being shown), `hud: HUDState` (built from `state.hud`; `activity` string localized from the structured form: "Running \(tool): \(detail)", "Subagent working", "Thinking…", "Idle", "Claude is working…"), `pendingPermission`, `branches`, `isWorktreeDirty`, `branchSwitchBlocker()`, `reviewNotes`, `needsGitInit`, `gitCandidates: [URL]`, `gitInitLooksUnsafe`, `toolchain: Toolchain?` (node from Swift locator + claude from `state.toolchain`), `lastError`, `selectedFile`, `selectedPath` (get/set → `selectFile`).
  - Methods with identical signatures: `openProject(URL) async`, `switchProject(to:) async`, `closeProject() async`, `initRepository() async`, `cancelGitInit()`, `send(_:)`, `interrupt()`, `respondPermission(allow:message:)`, `updateBudget(_:)`, `selectFile(_:)`, `accept(_:)`, `reject(_:)`, `acceptAll()`, `rejectAll()`, `retryCollectReview()`, `fullFile(for:) async throws -> FullFileView`, `refreshBranches() async`, `switchBranch(_:) async`, `createBranch(_:) async`, `addNote(...)`, `removeNote(id:)`, `requestChanges(extraMessage:)`, `shutdown() async`.
  - Event loop: `for await ev in client.events`: `.state` → assign (+ `AppSettings.setCachedCapabilities` when capabilities arrive; if `gate.turnEndTree` changed → clear `diffCache`, auto-select first changed file); `.userMessage` → `transcript.append(.user)`; `.textDelta` / `.toolUse` / `.toolResult` / `.permissionRequest` / `.budgetEvent` / `.turnEnd` / `.error` → the same transcript logic that lives in `SessionStore.handle` today (streaming-assistant merge, permission decision fill-in); `.log` → `logs` (cap 500). `respondPermission` also patches the transcript's `.permission` row as today.
  - `accept(_:)` sends `accept{paths:[p]}` and, if `p` was selected, selects the next pending file locally (selection is client state; the engine does not track it).
  - `recordProjectOpened` stays here (`AppSettings.addRecentProject`).
- `Session/PRStore.swift` (same type name, same public API as today) — thin mirror of `state.pr`: `host` (get: state; set: `set_settings{ghHost}` + UserDefaults), `mine`, `reviewRequested`, `selectedSummary`, `selected`, `files` (as `[PRFile]` with `patch = nil`), `comments`, `reviews`, `selectedFile`, `selectedDiff` (from `pr_select_file` reply), `isLoading`, `isSubmitting`, `errorText` (get/set; set nil → local clear), `draftComments`, `accounts`, `lastSubmitResult`; methods `refresh()`, `open(_:)`, `selectFile(_:)`, `reloadComments()`, `reloadReviews()`, `addDraft(_:)`, `removeDraft(id:)`, `submit(event:body:)`, `reply(to:body:)`, `refreshAccounts()`, `openLoginInTerminal(host:)`. `AppState` owns it and forwards `state.pr` on every snapshot.
- `Session/ToolchainLocator.swift` — reduce to node + loginPATH (drop claude fields; `Toolchain.claudePath/claudeVersion` become inputs from state).
- `Session/AppSettings.swift` — add `static func engineSettings(defaults:) -> EngineSettings` (renders prompt, parses ignore patterns, `autoAllowTools`, `loadUserSettings`, overrides, `ghHost` from `PRStore.hostDefaultsKey`).

App view changes (all in `App/`), intentionally minimal:

| File | Change |
|---|---|
| `ReviewGateApp.swift` | `SessionStore(scriptPath:)` → `AppState(engineScript:)`; `@State prStore = PRStore()` → `.environment(store.pr)`; `AppDelegate.store: AppState`. |
| `UI/MainWindow.swift` | `@Environment(SessionStore.self)` → `AppState.self`; `SessionStore.ProjectInfo` → `ProjectInfo`. Everything else compiles unchanged. |
| `UI/Chat/ChatView.swift`, `UI/Chat/HUDStrip.swift`, `UI/Sidebar/ChangedFilesList.swift`, `UI/Diff/DiffView.swift`, `UI/Diff/FullFileView.swift`, `UI/Settings/SettingsView.swift` | Only the environment type rename (one `sed`). `SettingsView` toolchain rows keep working through `store.toolchain`. |
| `UI/PR/*` | **No change** (`PRStore` name and API preserved). |
| `UI/Diff/DiffRow.swift`, `ExternalEditor.swift`, `PermissionCard.swift`, `BudgetBadge.swift`, `CommentComposer.swift` | No change. |

Deleted from Core in step 4: `Session/SessionStore.swift`, `Git/GitCheckpoint.swift`, `Git/GitBranches.swift`, `Git/CheckpointIgnore.swift`, `PR/GHClient.swift`, `PR/GHAuth.swift`, old `PR/PRStore.swift`, `Diff/UnifiedDiffParser.swift`, `Sidecar/SidecarProtocol.swift`, plus the tests listed in section 1. Core `Package.swift` keeps Highlightr.

---

## 5. Migration order (Mac app green at every step)

**Step 0 — Workspace scaffold (no behavior change).** Root `package.json` with workspaces; `engine/` with empty `src/index.ts`, vitest, tsconfig; `sidecar/package.json` gains the engine dependency; `Makefile`/`project.yml` pre-build script switched to root `npm ci` + `npm run build -w sidecar`. Verify: `make build` produces the same `dist/sidecar.mjs`; `make test` (swift + vitest empty) passes; `e2e.sh` pong round-trip.

**Step 1 — Port pure logic + tests to TS (parity first).** In order: `git/exec.ts` → `git/checkpoint.ts` + `git.checkpoint.test.ts` (same fixture repo and assertions as `GitCheckpointTests.changesPatchAndRevertRoundTrip`, including the index-fingerprint invariance) → `git/branches.ts` → `diff/parse.ts` (12 golden tests) → `diff/fullfile.ts` → `git/ignore.ts` + `git/repo.ts` → `pr/gh.ts` + `pr/auth.ts` (fixtures copied from the Swift tests and `docs/gh-auth-status.json`) → `review/notes.ts` + `review/gate.ts` (state machine, tested through a `FakeClaudeSession`) → `pr/store.ts` → move `budget.ts`/`hooks.ts`/`queue.ts` under `engine/src/session/` and reshape `sidecar/index.ts` globals into `session/claude.ts` (`ClaudeSession` class with `emit` injected). Sidecar still ships v1 by importing from the engine. Verify: `npm test -w engine` green (counts: ≥ 45 tests), Swift tests still green, `driver.mjs` v1 headless script still works, `e2e.sh`.

**Step 2 — `ReviewEngine` + protocol v2 in the sidecar, v1 kept.** `engine/src/engine.ts`, `state.ts`, `protocol.ts`; `sidecar/src/index.ts` sniffs the first line: `hello` → v2 adapter, `start_session` → v1 legacy adapter (a thin shim mapping v1 messages onto `ClaudeSession` directly). Add `sidecar/test/driver-v2.mjs` (checked in, replaces the scratchpad one): spawns the sidecar, `hello` → `open_project /tmp/rg-scratch` → `send "Add a line to README"` → auto-allow permission → waits for `state.gate.phase == "reviewing"` → `select_file` → `reject_all` → asserts README restored → `add_note` + `request_changes` → `accept_all` → `switch_branch`/`create_branch` → `shutdown`, checking no orphan `claude`. This becomes the engine-level E2E and is the same script the Windows machine will run. Verify: driver-v2 passes; v1 `e2e.sh` still passes (Mac app untouched).

**Step 3 — Swift switches to v2.** Add `Engine/EngineProtocol.swift` + `EngineProtocolTests` (decodes `engine/test/fixtures/wire/*.json` goldens), `Engine/EngineClient.swift`, `Session/AppState.swift`, new `Session/PRStore.swift`; rename `SidecarClient` → `EngineTransport` (its tests keep passing against the fake-sidecar shell script). Flip `ReviewGateApp.swift` and the environment types in the six views. Old `SessionStore` still compiles but is unreferenced. Verify with the scratchpad GUI E2E set, all via AX identifiers that did not change: `e2e.sh` (open via `REVIEWGATE_PROJECT`, send, "pong", clean quit/no orphans), `m2e2e.sh` + `review.applescript` (accept / reject / reject-all revert on disk), `m3e2e.sh` (permission card allow/deny), `m6.sh` (git-init sheet, recents, collect-failure retry), M8 flows through `ax8`: `Branch switcher` → `New Branch…` → `Create branch`, `Add note` → `Request changes` → follow-up turn keeps `other.txt` accepted; PR flow: `Sidebar tab` PRs → `Refresh` → open PR → `Add to review` → `Submit review` (against `GH_LIVE=1` test repo), Accounts tab `Log in…` opens Terminal. Also `SettingsView` budget stepper → `set_settings` applies live (check HUD budget badge).

**Step 4 — Delete Swift logic and v1.** Remove the files listed in section 1, the v1 legacy adapter in the sidecar, `sidecar/src/protocol.ts`; shrink `ToolchainLocator`/`CommandRunner`; update `README.md` structure section and `docs/M2/M6/M7/M8-API.md` (mark superseded by `PROTOCOL.md` v2 + a new `docs/M9-ENGINE.md` with the `ReviewEngine` API). Verify: `make test`, full E2E set again, `git grep -n "SessionStore\|GitCheckpoint\|UnifiedDiffParser"` returns nothing outside docs history.

---

## 6. M10 — Electron client sketch (`clients/windows/`)

```
clients/windows/
  package.json          # electron ^33, electron-builder, react 19, monaco-editor, zustand, vite + vite-plugin-electron; depends on @reviewgate/engine
  electron-builder.yml  # appId io.github.seunggulee1007.reviewgate, win: { target: nsis }, nsis: { oneClick: false, perMachine: false }, files: dist/**, asar: true, asarUnpack: none needed (engine spawns external claude.exe/gh.exe/git.exe)
  src/main/main.ts      # app.whenReady → BrowserWindow(preload); engine = new ReviewEngine({ platform: createPlatform("win32"), env: process.env, log })
                        # ipcMain.on("rg:cmd", (_, cmd) => engine.handle(cmd)); engine.on(ev => win.webContents.send("rg:evt", ev)); app.on("before-quit") → await engine.dispose()
  src/main/settings.ts  # electron-store: same keys as AppSettings; builds Settings for hello/set_settings
  src/main/editor.ts    # "Open in Editor": VS Code (`code -g path:line` via where.exe), IntelliJ (idea64.exe --line), Explorer (shell.showItemInFolder)
  src/preload.ts        # contextBridge.exposeInMainWorld("rg", { send(cmd), request(cmd) /* id correlation */, onEvent(cb) })
  src/renderer/
    store.ts            # zustand: { state: ReviewState, transcript: ChatItem[], selectedPath, selectedDiff, logs } — literally the AppState logic in TS (could later be shared as engine/src/client/transcript.ts)
    App.tsx             # sidebar (Changes | PRs) + split: DiffPane | Chat — same layout as MainWindow
    components/ChangedFiles.tsx, DiffPane.tsx (Monaco DiffEditor: oldText/newText from full_file_content, renderSideBySide toggle, glyph-margin "+" → note; unified hunk list fallback from file_diff for binary/too-large), FullFilePane.tsx, Chat.tsx, PermissionCard.tsx, HUD.tsx, BranchMenu.tsx, GitInitDialog.tsx, PR/{List,Detail,DiffPane,SubmitSheet}.tsx, Settings.tsx (incl. Accounts with "Log in…" → login_in_terminal)
  test/driver-v2.mjs    # reuses sidecar/test/driver-v2.mjs against the in-process engine (node script importing @reviewgate/engine)
```

Must be verified on a real Windows machine (not emulatable on macOS): `claude.exe` spawn + streaming + `interrupt()` + PreToolUse hook round-trips; process-tree kill on window close (`taskkill /T`); git for Windows with `core.autocrlf=true` repo (snapshot/diff/revert line counts), `core.longpaths`, Korean filenames; `gh.exe` `auth status --json hosts` with GHE host + `hosts.yml` under `%APPDATA%`; `start cmd /k gh auth login --web` opens the browser; Defender/antivirus locking `rg-index-*` during `git add -A`; NSIS install → first launch with no `claude` installed shows the toolchain error in Settings; DPI scaling of Monaco; `%TEMP%` cleanup.

---

## 7. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| `core.autocrlf=true` repos: worktree CRLF vs blob LF | Diff/numstat could show whole-file changes if normalization differs between A and B | Both snapshots go through the same `git add -A` normalization, so A/B are consistent; `revert` uses `git restore` (repo policy). Document: never write files with the engine's own `fs` except the `writeBlob` fallback — there, respect `.gitattributes` by preferring `git restore` first (already the order). Test on Windows with `autocrlf=true` in `driver-v2`. |
| Long paths on Windows (> 260) | `git add`/`restore` fail | `-c core.longpaths=true` on win32; surface `error{scope:"git"}` with the path. |
| `gh` on Windows | Different config dir, `.exe` resolution, slower startup | `platform.ghConfigDir()`, `where.exe`, keep 8s per-host timeout, 90s API timeout. |
| Spawning `claude` on Windows via SDK | npm `.cmd` shim needs a shell; Electron has no `node` | Prefer native `claude.exe`; for `.cmd`, resolve `cli.js` and run under `process.execPath` (`ELECTRON_RUN_AS_NODE=1`). Custom `spawnClaudeCodeProcess` already exists — extend it. |
| Orphaned `claude` on Windows | `child.kill()` doesn't kill grandchildren | `taskkill /pid /T /F` in `platform.win32.killTree`; keep the 1s escalation. |
| TCC on macOS unchanged (engine still spawned by the app bundle) | Same first-launch "access Desktop" prompt as today | No new risk; note in README (already in learnings). Windows has no equivalent. |
| `state` snapshot size / frequency | Sluggish UI with many PR files/comments or chatty HUD | Patches excluded from `state.pr.files`; coalesced emission; `seq`; measure with `driver-v2` logging max bytes/s; `state_patch` deferred with a concrete trigger (> 200 KB or > 20/s). Swift decode is off-main (`Task.detached`) before assigning on `@MainActor`. |
| Two clients' behavior drift | Reason for the refactor | All reason codes and messages originate in the engine; clients only localize. `driver-v2.mjs` is the shared conformance test. |
| Losing Swift test coverage of git edge cases during the port | Silent regressions | Step 1 requires TS tests to assert the same values as the Swift tests before Swift tests are deleted (step 4). Fixture repo builder mirrors `GitCheckpointTests.makeRepo`. |
| Engine process lifetime now spans projects | A crash loses PR state too | `EngineClient` auto-respawns and replays `hello`/`set_settings`; AppState shows an error row and keeps `recentProjects` so reopening is one click. |
| `ProcessInfo`-based `ppid==1` watchdog on Windows | Never fires | Windows relies on stdin EOF; Electron runs in-process (no watchdog needed). |

---

### Critical Files for Implementation

- `Core/Sources/ReviewGateCore/Session/SessionStore.swift` — the semantics being ported into `engine/src/review/gate.ts` and `engine/src/engine.ts` (every guard, phase transition, request-changes rule and HUD accounting comes from here)
- `sidecar/src/index.ts` — becomes `engine/src/session/claude.ts` (`ClaudeSession` class) plus the thin stdio adapter
- `Core/Sources/ReviewGateCore/Git/GitCheckpoint.swift` — port target for `engine/src/git/checkpoint.ts` (temp-index snapshot, `-z` parsing, revert fallback)
- `Core/Sources/ReviewGateCore/Sidecar/SidecarClient.swift` — reused as `EngineTransport` under the new `Engine/EngineClient.swift`
- `docs/PROTOCOL.md` — rewritten to v2 (section 3 above), the contract both `Core/Sources/ReviewGateCore/Engine/EngineProtocol.swift` and `engine/src/protocol.ts` implement