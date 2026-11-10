# M12 — Commit & push accepted changes

## Engine (protocol v2 additions)
Command `commit { message: string; paths?: string[] /* default: all files with state "accepted" in the current review */; push?: boolean /* default false */; id? }`
- Refuses (`result{ok:false}`): `no_project`, `session_running` (gate.phase running/collecting/reverting), `nothing_to_commit` (no accepted files / empty paths / paths not accepted), `empty_message`, `git_identity_missing` (user.name/email unset — detail text), `push_failed:<stderr first line>` (commit stays; state.commit.lastCommit.pushed=false, pushError set).
- Runs: `git add -A -- <paths>` (handles deletes/renames: for renamed files add both old and new path), `git commit -m <message>` (message may be multi-line; use `-F -` via stdin), then if `push`: `git push` (if no upstream → `git push -u origin <branch>`; if no remote → `no_remote`).
- After success: remove committed paths from `changedFiles` (they are no longer part of the review), re-snapshot `turnEndTree` so later diffs are correct, refresh branches/workbenches, set `state.commit.lastCommit = { sha, shortSha, message, branch, pushed, pushError: string|null, files: string[], at: ISO }`.
- Reply event `committed { id?, sha, shortSha, pushed, branch }`.
- State: `state.commit = { lastCommit: … | null; canCommit: boolean /* accepted files exist && gate not running */; acceptedPaths: string[]; identity: { name: string|null; email: string|null } /* read at open_project */ }`.
- Default message helper in engine: `suggestCommitMessage(): string` = first line of the last user instruction (≤ 72 chars, strip "[Review gate]" prefixes) + blank line + `Files:\n- a\n- b` — exposed as `state.commit.suggestedMessage`.
- Settings: `commitPushByDefault?: boolean` (default false), `commitTrailer?: string` (default "" — e.g. "Co-Authored-By: …" appended as a trailer line).

## Mac UI
- Changes header: "Commit accepted (N)…" button (AX "Commit accepted"; ⌘⇧K) enabled when `state.commit.canCommit`; sheet: message editor prefilled with `suggestedMessage`, checklist of accepted files (default all), toggle "Push to origin" (default from settings), Commit button; refusal text localized from codes.
- After commit: green banner "Committed <shortSha> on <branch> · pushed/not pushed" with "Create PR…" (opens the existing CreatePR sheet) and "Open" if pushed and remote is GitHub (URL = remote web URL + /commit/sha). Push error → red banner with retry ("Push now" = `commit`? no → new command `push {}` → same push logic; add it).
- Settings → General: "Push by default", "Commit trailer" field.

## Electron UI
Same as Mac: `CommitDialog.tsx`, header button, banner, settings fields.

## Tests
engine: temp repo → fake turn → accept a,b, reject c → commit {push:false} → `git log -1` message/files, c still pending, changedFiles without a,b, turnEndTree re-snapshot; refusals; push to a local bare remote (with/without upstream); identity missing; `push {}` after a failed push.
Mac/Electron: protocol decode of `state.commit`, `committed` event; GUI: accept 1 of 2 → Commit accepted (1) → sheet → commit → banner + `git log` shows it, other file still pending.
