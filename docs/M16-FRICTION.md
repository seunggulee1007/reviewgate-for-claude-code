# M16 — Friction fixes

## Engine
1. **Read-only Bash auto-allow** (default ON, setting `autoAllowReadOnlyBash: true`): a Bash command is auto-allowed when every pipeline segment's first token is in the read-only set (`ls cat head tail wc pwd which type echo printf grep rg find fd stat file env date whoami tree du df ps id uname sort uniq cut sed(-n only, no -i, safe scripts only) tr jq node --version|-v npm ls|view|-v python3 --version`, `git status|log|diff|show|branch|rev-parse|remote|ls-files|blame|describe|tag`), no redirection (`>`, `>>`, `<(`), no `;`/`&&`/`||` chaining with non-read-only segments, no `$(`/backticks, no `sudo`, no `rm|mv|cp|tee|xargs|eval|exec`. Otherwise → ask as today.
2. **Allow patterns** setting `bashAllowPatterns: string[]` (Claude-style `Bash(npm test:*)`, `Bash(git *)`), evaluated in `preBash` before ask. **Session remember**: `permission_response { allow:true, remember: true }` → auto-allow the same tool + command prefix (first two tokens for Bash, tool name for others) for the rest of the session; `state.session.rememberedAllows: string[]`; command `forget_allows`.
3. **Accept-and-send**: `send { text, acceptPending?: boolean }` — when `acceptPending` and the gate is `reviewing` with pending (not changesRequested) files, accept them all, then send. Refused while `running`.
   > **Superseded (correctness fix).** Making this the composer's default silently accepted a whole review when the user only
   > meant to ask a question — the review list was wiped while the changes stayed on disk. Now: a plain `send` while reviewing is
   > ALLOWED and changes nothing (it is answered against the same snapshot A, and the answer's own changes merge into the
   > standing review); `acceptPending` survives only as a separate, explicitly chosen "Accept N & Send" action (Mac ⌘⇧↩ menu
   > button, Electron split-button dropdown, confirmed above three files). See docs/PROTOCOL.md §3 (`send`, gate semantics) and
   > §10 ("Accept-and-send").
4. **Budget defaults** → `maxFiles 10`, `maxLines 400`, `hardMultiplier 2.0` (engine `DEFAULT_SETTINGS`; clients' defaults too). Soft warning stays at 100%.
5. `state.gate.reviewSummary: { files, added, deleted }` for the composer label.

## Clients (Mac + Electron)
- Composer stays enabled while reviewing. *(Superseded with item 3: Send stays plain **"Send"** (AX "Send") and never accepts; **"Accept N & Send"** (AX "Accept and send") is a separate action next to it. The pending banner reads "N files pending review — you can ask questions without accepting".)*
- Permission card: **"Allow for session"** (remember) + Allow + Deny; read-only commands never appear.
- **Markdown rendering** for assistant text: headings, bold/italic, inline code, links, lists, fenced code blocks in monospaced boxes with language label and Copy button. Mac: custom lightweight renderer (split fences; inline via `AttributedString(markdown:)`); Electron: `marked` + sanitize (DOMPurify) or a tiny custom renderer — no raw HTML.
- **Diff pane auto-collapse**: when Changes tab has no changed files and nothing selected, collapse the diff pane (chat takes the width); expands when files arrive or the user toggles (⌘⇧D, remembered per project).
- Banner tidy: at most one banner stack area above the chat/diff; integrity chips merged into a single "N notices" chip when > 1; restored banner auto-hides after 8s.
- Slash palette: populated from cached capabilities before the first turn (already) — also trigger `session_info` earlier if possible (engine: emit capabilities cache from `<gitDir>/reviewgate/capabilities.json` on open_project).
- Settings: new defaults; Permissions section: Read-only Bash auto-allow toggle, allow patterns editor (one per line), "Forget session allows".
