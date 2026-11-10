# M19 — Multiple projects at once + session restore on launch

## Behavior
1. **Open in New Window** — File → "Open in New Window…" (⌘⇧N) opens a folder picker and opens the chosen project in a NEW window (own engine/sidecar, own lock). The project switcher menu and the Recent list gain "Open in New Window" per row (Mac: ⌥-click or a submenu item; Electron: context menu / ⌥-click). Choosing a project that is already open in another window focuses that window instead of opening a duplicate (the engine lock already refuses the duplicate; the client must focus rather than show the takeover alert when the lock owner is one of our own windows — match by pid, and by window registry first).
2. **Restore on launch** — on app start with no explicit project (no `REVIEWGATE_PROJECT`), reopen the windows that were open at last quit: persisted list `openWindows: [{path, frame?}]` (Mac: UserDefaults `openWindows`; Electron: settings `openWindows`), written whenever a window opens/closes/changes project and on quit. Setting "Reopen last projects on launch" (default ON) in Settings → General; when OFF or the list is empty, show the empty state as today. Windows whose path no longer exists are skipped (and dropped from the list). Cap at 5 windows; restore in the saved order; the first restored window gets focus.
3. **Window geometry per project** — remember each window's frame keyed by project root (Mac: `NSWindow.setFrameAutosaveName`-equivalent stored in `ProjectUIState.frame`; Electron: `ui.<hash>.bounds`), restore on open, clamp to the visible screen.
4. Window title already `<repo> — <branch>`; add the project folder name to the Dock/Window menu entries. Keep the "workbench" badge.
5. Quit: `applicationShouldTerminate` / `before-quit` must dispose every engine (already true) AND persist the window list first.

## Notes
- A workbench window counts as its own entry (its path is the worktree path).
- Restoring must not race the lock: open windows sequentially (await each `open_project` reply or a 1.5s timeout) so two windows never fight over one worktree.
