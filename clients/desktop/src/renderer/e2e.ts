/**
 * `electron . --e2e` (docs/M11-WINDOWS.md): scripted sequence against the REAL engine + real
 * `claude`, driven through the store so the UI shows what a user would see. The primary window
 * runs the review scenario and the lock-conflict scenario (a second window on the same project),
 * takes the screenshot and reports; the secondary window only reports whether `state.lockConflict`
 * was set. Main (src/main/e2e.ts) prints the JSON and exits.
 */
import type { EngineCommand, EngineEvent, ReviewState } from "@reviewgate/engine";
import { frictionScenario } from "./e2eFriction";
import { planScenario, type PlanReport } from "./e2ePlan";
import { sessionSwitchRefusal, sessionsOf } from "./sessions";
import { commitOf, useStore } from "./store";

type Role = { role: "primary" | "secondary"; project: string };

const STEP_TIMEOUT_MS = 240_000;

const steps: string[] = [];
let turns = 0, fileDiffs = 0, permissionRequests = 0, maxStateBytes = 0;
/** `retry_collect`s the harness issued (a transient file under an ignored folder can break `git add -A` mid-turn). */
let collectRetries = 0, lastCollectError: string | null = null;

function recordEvent(ev: EngineEvent): void {
  if (ev.type === "turn_end") turns++;
  if (ev.type === "permission_request") permissionRequests++;
  if (ev.type === "file_diff") fileDiffs++;
  if (ev.type === "state") maxStateBytes = Math.max(maxStateBytes, JSON.stringify(ev.state).length);
}

const state = (): ReviewState => useStore.getState().state;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Polls `pred` every 50 ms; auto-allows any permission card so the scenario never blocks on one
 * (pass `autoAllow: false` when the step itself needs to inspect/answer the pending permission) and
 * presses Retry once per distinct `collect_failed` error, as a user would.
 */
async function waitFor(label: string, pred: () => boolean, timeoutMs = STEP_TIMEOUT_MS, autoAllow = true): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${label}`);
    const s = useStore.getState();
    if (autoAllow && s.state.session.pendingPermission) s.respondPermission(s.state.session.pendingPermission.requestId, true);
    if (s.state.gate.phase === "collect_failed" && s.state.gate.collectError && s.state.gate.collectError !== lastCollectError) {
      lastCollectError = s.state.gate.collectError;
      collectRetries++;
      s.retryCollect();
    }
    const fatal = s.transcript.find((i) => i.kind === "error" && i.fatal);
    if (fatal && fatal.kind === "error") throw new Error(`fatal engine error while waiting for ${label}: ${fatal.message}`);
    await sleep(50);
  }
  steps.push(label);
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  steps.push(`assert ${msg}`);
}

function file(path: string) {
  return state().changedFiles.find((f) => f.path === path);
}

async function sendAndWaitTurn(text: string): Promise<void> {
  await waitFor(`canSend before "${text.slice(0, 24)}…"`, () => state().gate.canSend);
  const before = turns;
  useStore.getState().send(text);
  await waitFor(`turn_end after "${text.slice(0, 24)}…"`, () => turns > before);
}

async function primary(mode: Role): Promise<Record<string, unknown>> {
  const store = useStore.getState;
  const sep = mode.project.includes("\\") ? "\\" : "/";
  const abs = (rel: string) => `${mode.project}${sep}${rel}`;

  await waitFor("project open + session ready", () => state().project !== null && state().session.open && state().gate.canSend);

  // 0. IPC allowlist (src/main/ipcGuard.ts): forged `hello` / `set_settings` from the renderer never reach the engine.
  for (const type of ["hello", "set_settings"]) {
    const outcome = await window.rg.request({ type } as unknown as EngineCommand).then(() => "accepted", (e: Error) => e.message);
    assert(outcome === `rejected command: ${type}`, `forged ${type} rejected by main (${outcome})`);
  }

  // 1. a no-op turn
  await sendAndWaitTurn("Reply with the word pong only");
  await waitFor("gate idle after pong", () => state().gate.phase === "idle" || state().gate.phase === "reviewing");

  // 1a. chat tabs (docs/M15-POLISH.md): session_new → second tab, a turn there, session_open back → transcript swapped, refresh ok.
  const firstChat = sessionsOf(state()).currentId;
  await waitFor(`first chat ${firstChat} is an open tab`, () => firstChat !== null && sessionsOf(state()).openTabIds.includes(firstChat));
  assert(await store().newChat(), "session_new accepted");
  await waitFor("second tab open", () => sessionsOf(state()).openTabIds.length === 2 && sessionsOf(state()).currentId !== firstChat);
  await waitFor("transcript swapped to the new chat", () => !store().replaceTranscript && store().transcript.every((i) => i.kind !== "assistant"));
  await sendAndWaitTurn("Reply with the word ping only (not pong)");
  assert(store().transcript.some((i) => i.kind === "assistant" && i.text.toLowerCase().includes("ping")), "assistant replied 'ping' in the new chat");
  await waitFor("gate idle after ping", () => state().gate.phase === "idle" || state().gate.phase === "reviewing");
  assert(await store().openChat(firstChat!), "session_open (first chat) accepted");
  await waitFor("first chat transcript restored", () => !store().replaceTranscript && sessionsOf(state()).currentId === firstChat && store().transcript.some((i) => i.kind === "assistant" && i.text.toLowerCase().includes("pong")));
  assert(!store().transcript.some((i) => (i.kind === "assistant" || i.kind === "user") && i.text.toLowerCase().includes("ping")), "first chat transcript has no 'ping'");
  assert(sessionsOf(state()).list.length === 2 && sessionsOf(state()).openTabIds.length === 2, "two sessions listed, two tabs");
  await waitFor("canSend after session_open", () => state().session.open && state().gate.canSend);
  assert(await store().refresh(), "refresh accepted");
  assert(!store().isRefreshing, "refresh spinner cleared");

  // 1b. restart_session (docs/PROTOCOL.md §8): new session, same conversation (resume), gate untouched.
  const sessionIdBeforeRestart = state().session.sessionId;
  await waitFor("canRestart before restart_session", () => state().session.canRestart);
  await store().restartSession();
  await waitFor("session open again after restart_session", () => state().session.open && !state().session.starting && state().gate.canSend);
  assert(state().session.sessionId === sessionIdBeforeRestart, `session id unchanged after restart (${state().session.sessionId})`);
  await sendAndWaitTurn("Reply with the word pong only");
  assert(
    store().transcript.some((i) => i.kind === "assistant" && i.text.toLowerCase().includes("pong")),
    "assistant replied 'pong' after restart_session (resume worked)",
  );

  // 1c. AskUserQuestion (components/chat/QuestionCard.tsx): answer "green" via `answerQuestions` —
  // the store sends `updatedInput.{questions,answers}` and Claude reports the picked color back.
  await waitFor("canSend before AskUserQuestion turn", () => state().gate.canSend);
  const turnsBeforeQuestion = turns;
  store().send("Use the AskUserQuestion tool to ask me which color I prefer: red, green or blue (single select). Then reply with the color I picked and nothing else.");
  await waitFor("AskUserQuestion permission pending", () => state().session.pendingPermission?.toolName === "AskUserQuestion", STEP_TIMEOUT_MS, false);
  const questionReq = state().session.pendingPermission!;
  const questions = (questionReq.input["questions"] as { question: string }[] | undefined) ?? [];
  assert(questions.length === 1 && typeof questions[0]?.question === "string", `AskUserQuestion carries one question (${questions.length})`);
  store().answerQuestions(questionReq.requestId, { [questions[0]!.question]: "green" });
  await waitFor("turn_end after AskUserQuestion", () => turns > turnsBeforeQuestion);
  assert(
    store().transcript.some((i) => i.kind === "assistant" && i.text.toLowerCase().includes("green")),
    "assistant reported 'green' after answering AskUserQuestion",
  );

  // 1d. docs/M16-FRICTION.md: read-only Bash never asks, Allow for session, Accept 1 & Send (src/renderer/e2eFriction.ts).
  await frictionScenario({ waitFor, assert, turns: () => turns, permissionRequests: () => permissionRequests });

  // 1e. docs/M20-MODES.md: plan mode → plan proposal → Approve & run → the follow-up turn's file is rejected again.
  const plan: PlanReport = await planScenario({ waitFor, assert, turns: () => turns, permissionRequests: () => permissionRequests });

  // 2. an editing turn → reviewing
  await sendAndWaitTurn("Append one new line containing exactly the word 'electron' at the very end of README.md (it must become the last line of the file), and create e1.txt with 3 lines. Do only that.");
  await waitFor("gate reviewing", () => state().gate.phase === "reviewing");
  assert(file("README.md")?.state === "pending", "README.md pending");
  assert(file("e1.txt")?.state === "pending", "e1.txt pending");

  // 2a. a question while reviewing (docs/PROTOCOL.md §10): the Send path never accepts — the review
  // list, its file states and snapshot A all survive the answer turn untouched.
  assert(state().gate.canSend, "input is open while reviewing (a question needs no accept)");
  const reviewBefore = JSON.stringify(state().changedFiles.map((f) => [f.path, f.state]));
  const treeBefore = state().gate.turnStartTree;
  const turnsBeforeQuestion2 = turns;
  store().send("How many files did you change in the previous turn? Reply with just the number. Change nothing.");
  await waitFor("turn_end after the question", () => turns > turnsBeforeQuestion2);
  await waitFor("still reviewing after the question", () => state().gate.phase === "reviewing");
  const reviewAfter = JSON.stringify(state().changedFiles.map((f) => [f.path, f.state]));
  assert(reviewAfter === reviewBefore, `review list unchanged by the question (${reviewBefore} → ${reviewAfter})`);
  assert(state().gate.pendingCount === 2, `both files still pending after the question (${state().gate.pendingCount})`);
  assert(state().gate.turnStartTree === treeBefore, "snapshot A kept across the question turn");

  // 2b. a new chat during a pending review (docs/PROTOCOL.md §9): plainly pending files no longer refuse
  // the switch, and the review — worktree state, not session state — survives it exactly as it was.
  assert(sessionSwitchRefusal(state()) === null, "chat switching allowed while files are plainly pending");
  const reviewChat = sessionsOf(state()).currentId;
  const pendingBefore = JSON.stringify(state().changedFiles.map((f) => [f.path, f.state]));
  const treeBeforeNewChat = state().gate.turnStartTree;
  assert(await store().newChat(), "session_new accepted during the pending review");
  await waitFor("third chat open while reviewing", () => sessionsOf(state()).currentId !== reviewChat && state().session.open && state().gate.canSend);
  assert(JSON.stringify(state().changedFiles.map((f) => [f.path, f.state])) === pendingBefore, `review list survived the new chat (${pendingBefore})`);
  assert(state().gate.turnStartTree === treeBeforeNewChat && state().gate.pendingCount === 2, "snapshot A and both pending files survived the new chat");
  // The first send in the new chat is a question as well: it merges into the same review.
  const turnsBeforeNewChat = turns;
  store().send("Reply with the word ok only. Change nothing.");
  await waitFor("turn_end in the new chat", () => turns > turnsBeforeNewChat);
  await waitFor("still reviewing after the new chat's send", () => state().gate.phase === "reviewing");
  assert(JSON.stringify(state().changedFiles.map((f) => [f.path, f.state])) === pendingBefore, "the new chat's send merged into the same review");
  assert(state().gate.turnStartTree === treeBeforeNewChat, "snapshot A kept across the new chat's send");
  assert(sessionsOf(state()).list.length === 3, `three chats listed (${sessionsOf(state()).list.length})`);
  // Back to the chat that made the changes for the rest of the scenario.
  assert(await store().openChat(reviewChat!), "session_open back to the reviewing chat accepted");
  await waitFor("back in the reviewing chat", () => sessionsOf(state()).currentId === reviewChat && state().session.open && state().gate.canSend);
  assert(state().gate.pendingCount === 2, `both files still pending after switching back (${state().gate.pendingCount})`);

  // 3. select_file → file_diff (the store may already have auto-selected + cached it), full_file
  store().selectFile("README.md");
  await waitFor("file_diff README.md", () => store().selectedPath === "README.md" && store().selectedDiff !== null && fileDiffs >= 1);
  assert(store().selectedDiff!.hunks.some((h) => h.lines.some((l) => l.kind === "add" && l.text.includes("electron"))), "diff has +electron");
  assert(store().selectedDiff!.truncated === false && store().viewedPaths["README.md"] !== undefined, "diff not truncated, README.md marked viewed");
  const full = await store().fullFile("README.md");
  assert(full.lines.some((l) => l.trim() === "electron"), "full_file has electron line");

  // 4. accept README.md, reject e1.txt → disk
  store().accept("README.md");
  await waitFor("README.md accepted", () => file("README.md")?.state === "accepted");
  store().reject("e1.txt");
  await waitFor("e1.txt reverted", () => file("e1.txt") === undefined && state().gate.phase !== "reverting");
  const readme = await window.rg.e2eReadFile(abs("README.md"));
  assert(readme !== null && readme.replace(/\r?\n$/, "").split(/\r?\n/).pop() === "electron", "README last line is 'electron' on disk");
  assert((await window.rg.e2eReadFile(abs("e1.txt"))) === null, "e1.txt absent on disk");

  // 5. note + request_changes → reviewing again → accept_all
  const readmeLine = full.lines.findIndex((l) => l.trim() === "electron") + 1;
  store().addNote("README.md", readmeLine, "new", "electron", "Change the appended line to 'electron v2'");
  await waitFor("note added", () => state().reviewNotes.length === 1 && state().gate.canRequestChanges);
  const turnsBefore = turns;
  store().requestChanges(null);
  await waitFor("request_changes turn_end", () => turns > turnsBefore);
  await waitFor("gate reviewing after request_changes", () => state().gate.phase === "reviewing");
  assert(file("README.md") !== undefined, "README.md listed after request_changes");
  store().acceptAll();
  await waitFor("accept_all settled", () => state().gate.pendingCount === 0 && state().gate.canSend);
  const readme2 = await window.rg.e2eReadFile(abs("README.md"));
  assert(readme2 !== null && readme2.includes("electron v2"), "README contains 'electron v2' after request_changes");

  // 6. screenshot with README.md in the diff pane
  store().selectFile("README.md");
  await waitFor("README.md diff for screenshot", () => store().selectedPath === "README.md" && store().selectedDiff !== null);
  await sleep(800);
  const screenshot = await window.rg.e2eScreenshot("m11-desktop");
  steps.push(`screenshot ${screenshot}`);

  // 6a. M18 appearance: the same populated UI captured in both themes. `saveSettings` persists the
  // setting, mirrors it onto `nativeTheme.themeSource` in main and onto `<html data-theme>` +
  // Monaco here; the sleep lets Monaco repaint before `capturePage()`.
  const themeShots: Record<string, string> = {};
  const beforeAppearance = store().settings?.appearance ?? "system";
  for (const appearance of ["dark", "light"] as const) {
    await store().saveSettings({ appearance });
    await sleep(600);
    assert(document.documentElement.dataset.theme === appearance, `data-theme is ${appearance}`);
    themeShots[appearance] = await window.rg.e2eScreenshot(`m18-electron-${appearance}`);
    steps.push(`screenshot ${themeShots[appearance]}`);
  }
  await store().saveSettings({ appearance: beforeAppearance });

  // 7. commit the accepted file (docs/M12-COMMIT.md) → state.commit.lastCommit + `git log -1`
  await waitFor("canCommit (README.md accepted)", () => commitOf(state()).canCommit && commitOf(state()).acceptedPaths.includes("README.md"));
  const refusal = await store().commitAccepted({ message: "e2e commit", paths: ["README.md"], push: false });
  assert(refusal === null, `commit accepted (${refusal ?? "ok"})`);
  await waitFor("state.commit.lastCommit", () => commitOf(state()).lastCommit !== null);
  const last = commitOf(state()).lastCommit!;
  assert(/^[0-9a-f]{7,}$/.test(last.shortSha) && last.pushed === false && last.files.includes("README.md"), `lastCommit ${last.shortSha} not pushed, files include README.md`);
  assert(file("README.md") === undefined, "README.md no longer in the review after commit");
  const gitLog = await window.rg.e2eGitLog();
  assert(gitLog !== null && gitLog.startsWith(last.sha) && gitLog.endsWith("e2e commit"), `git log -1 is ${last.sha} "e2e commit"`);

  // 8. second window on the same project → lockConflict there
  const secondary = (await window.rg.e2eOpenSecondary()) as { ok?: boolean; lockConflict?: unknown; error?: string };
  assert(secondary.ok === true && secondary.lockConflict, `secondary window saw lockConflict (${secondary.error ?? "ok"})`);

  const hud = state().hud;
  return { ok: true, plan, turns, cost: Number(hud.sessionCostUSD.toFixed(4)), contextTokens: hud.contextTokens, maxStateBytes, collectRetries, screenshot, themeShots, commit: { sha: last.sha, shortSha: last.shortSha, branch: last.branch, gitLog }, secondary, steps };
}

async function secondary(): Promise<Record<string, unknown>> {
  await waitFor("secondary: lockConflict or project", () => state().lockConflict !== null || state().project !== null, 60_000);
  const lock = state().lockConflict;
  return { ok: lock !== null, lockConflict: lock, dialog: useStore.getState().dialog?.kind ?? null, project: state().project?.path ?? null };
}

export async function runE2E(mode: Role): Promise<void> {
  window.rg.onEvent(recordEvent);
  const role = mode.role;
  try {
    const result = role === "primary" ? await primary(mode) : await secondary();
    window.rg.e2eReport({ role, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const hud = state().hud;
    window.rg.e2eReport({ role, ok: false, error: message, steps, turns, cost: hud.sessionCostUSD, contextTokens: hud.contextTokens, maxStateBytes, collectRetries, phase: state().gate.phase, lastError: state().lastError });
  }
}
