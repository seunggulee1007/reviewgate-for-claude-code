# M10 — Workbenches (concurrent sessions on one project via git worktrees)

## Concept
A **workbench** = one git worktree (own directory + own branch) + one engine instance (own Claude session, own review gate) + one app window.
The original checkout is the "main workbench". Additional workbenches live under a managed folder:
`~/.reviewgate/worktrees/<repo-name>-<hash8>/<branch-slug>/` (configurable: setting `worktreeRoot`).
Never inside the repo (would show up in other workbenches' `git status`).

## Engine (protocol v2 additions)
Commands (all require an open project; operate on the project's *main* repository = `git rev-parse --git-common-dir`):
- `workbench_list` → `state.workbenches`
- `workbench_create { branch: string; from?: string /* default current HEAD of this workbench */; path?: string /* default managed folder */ }` → reply `result` + `state.workbenches`; runs `git worktree add <path> -b <branch> <from>` (or `git worktree add <path> <branch>` when the branch exists and is not checked out elsewhere). Refuses: invalid ref name, branch checked out in another worktree, path exists.
- `workbench_remove { path: string; force?: boolean }` → `git worktree remove [--force] <path>`; refuses the main worktree and any worktree with a live lock (see below) unless `force`.
- `workbench_prune` → `git worktree prune`.

State: `state.workbenches: { list: WorkbenchInfo[]; current: string /* path of this engine's worktree */; managedRoot: string }`
`WorkbenchInfo = { path: string; branch: string | null; head: string; isMain: boolean; isCurrent: boolean; locked: { pid: number; since: string; client: string } | null; dirty: boolean | null }`
(`git worktree list --porcelain` + per-worktree `status --porcelain` limited to 2s; `locked` from our lock file.)

Lock: on `open_project`, engine writes `<worktree>/.git/reviewgate.lock` (for linked worktrees `.git` is a file → use `git rev-parse --git-dir` to find the real gitdir) with `{pid, since, client, host}`; removed on `close_project`/`dispose`; stale if the pid is dead → overwritten. If a live lock exists for another pid → `open_project` fails with `result{ok:false, error:"locked_by_other_session:<pid>"}` and `state.gitInit`-style info `state.lockConflict = {pid, since, client}`; command `open_project { path, takeover: true }` overrides.

Per-worktree ignore: the managed root is added to nothing (it's outside the repo).

## Mac app
- Each workbench opens in its **own window** (`WindowGroup(for: URL.self)`), each window has its own `AppState` + `EngineClient` (own sidecar process). `AppDelegate.applicationShouldTerminate` shuts down all.
- Project switcher menu gains a "Workbenches" section: list (branch · dirty dot · lock badge "in use") → click opens/focuses that window; "New Workbench…" sheet (branch name, base branch picker, path preview) → creates and opens a new window; context menu "Remove Workbench" (confirm; refuses if in use/dirty unless force).
- Window title: `<repo> — <branch>`; when `isMain` false show a small "workbench" badge in the header.
- Refuse opening the same root twice: engine lock error → alert "This workbench is already open in another window/session (pid N since …). Take over?" (Take over = `open_project{takeover:true}`).
- When a workbench's review is done, "Create PR from this branch…" (M10.1, optional): `gh pr create --fill --head <branch> --base <main>` via engine command `pr_create { base, title?, body?, draft? }` → returns URL; shown in the Reviews banner.

### New Chat in a Workbench (PROTOCOL §9)
Turns go one at a time per worktree, so a new chat asked for while Claude works waits. "워크벤치에서 새 채팅…" (the chat menu,
Chat ›, ⌥⌘T; and [워크벤치에서 열기] on the "새 채팅 대기 중" chip) makes a workbench in one step instead: a one-field sheet
with the branch `wb/<yyMMdd-HHmm>` (editable; `-2`… when taken) and [만들기] (Return) → `workbench_create {branch}` from
HEAD → its window, whose first chat is of the default kind. A message held for a chat switch moves to that window's
composer (never sent; that first chat is then a chat). No engine command was added. Not offered without git (§59).
Windows: the same from the + button's right-click, Chat › and Ctrl+Alt+W; the message goes through main with the window.

## Windows client
Same commands; each workbench = one BrowserWindow with its own in-process `ReviewEngine`.

## Tests
- engine: create/list/remove/prune on a temp repo with managed root under tmp; lock create/stale/conflict/takeover; refuse main removal; branch-in-use refusal.
- Swift: EngineProtocol decoding of `state.workbenches` + `lockConflict`; commands encode.
- GUI: open project → New Workbench "feature-x" → second window titled `rg-scratch — feature-x`, both windows chat independently (pong in each), each has its own changed-files list; opening the same path again → takeover alert.
