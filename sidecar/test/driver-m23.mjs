#!/usr/bin/env node
// Engine-level E2E for docs/PROTOCOL.md §23–28 against the real `claude` CLI.
//
//   node sidecar/test/driver-m23.mjs [/path/to/scratch/repo]   (default $TMPDIR/rg-m23; RE-CREATED from scratch)
//   RG_MODEL=haiku (default) — every prompt is a Haiku-sized task.
//
//   1. list_files finds NOTES.txt; send{mentions:["NOTES.txt"]} — the CLI expands the @-mention itself: the answer
//      quotes the file's secret first word without any Read tool call.
//   2. send{attachments:[red PNG]} — the answer names the colour; the transcript row keeps only the hash;
//      attachment_get returns the same bytes.
//   3. set_model {sonnet, effort low} while idle → the next turn runs on Sonnet (session_info model), persisted in
//      reviewgate-session.json; back to the driver model.
//   4. checkpoints + rewind: turn A writes a.txt (and asks to remember "mango"), accept; turn B edits a.txt, writes
//      b.txt (and asks to remember "kiwi"). rewind{files} to B restores a.txt to A's content and removes b.txt;
//      rewind{conversation, editText} to B forks the chat before B: the answer knows mango, not kiwi; the old chat
//      stays as "… (되돌리기 전)".
//   5. compact{focus} runs /compact as a turn (context smaller afterwards); the conversation still knows mango.
//   6. interrupt while a permission card is open: the reply comes after turn_end{interrupted} + collection, a send
//      queued right behind it goes out.
// Asserts no `claude` / sidecar orphans at the end and prints what was observed as JSON.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { deflateSync, crc32 } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = process.argv[2] ?? join(tmpdir(), "rg-m23");
const SIDECAR = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${process.env.HOME}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "haiku";
const STEP_TIMEOUT_MS = 240_000;

const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
const t0 = Date.now();
const log = (msg) => process.stderr.write(`[m23 +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}\n`);
const assert = (cond, msg) => {
  if (!cond) {
    log(`ASSERTION FAILED: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
};

// ---------------------------------------------------------------- fresh scratch repo
rmSync(REPO, { recursive: true, force: true });
mkdirSync(REPO, { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main", REPO]);
git("config", "user.email", "m23@example.com");
git("config", "user.name", "m23");
writeFileSync(join(REPO, "README.md"), "# m23 scratch\n");
writeFileSync(join(REPO, "NOTES.txt"), "QUOKKA-4417 is the secret first word\nsecond line\n");
mkdirSync(join(REPO, "src"), { recursive: true });
writeFileSync(join(REPO, "src", "app.ts"), "export const app = 1;\n");
writeFileSync(join(REPO, ".gitignore"), ".omc/\n");
git("add", "-A");
git("commit", "-q", "-m", "m23: init");

/** A solid red 8×8 PNG. */
function redPng() {
  const w = 8, h = 8;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([255, 0, 0], y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (t, d) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc32(td));
    return Buffer.concat([l, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- sidecar plumbing (as driver-m22)
let state = null;
let nextId = 1;
const waiters = [];
const replies = new Map();
const events = [];
let child = null;
let exited = null;
/** When set, permission requests are left open (step 6) instead of allowed. */
let holdPermissions = false;

function startSidecar() {
  child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"] });
  createInterface({ input: child.stderr }).on("line", (l) => {
    if (!/:debug\]/.test(l)) process.stderr.write(`  [sidecar] ${l}\n`);
  });
  exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  state = null;
  createInterface({ input: child.stdout }).on("line", onLine);
}

function onLine(line) {
  const ev = JSON.parse(line);
  if (ev.type === "state") state = ev.state;
  else {
    events.push(ev);
    if (ev.type === "permission_request") {
      if (holdPermissions) log(`permission_request ${ev.toolName} → left open`);
      else {
        log(`permission_request ${ev.toolName} → allow`);
        send({ type: "permission_response", requestId: ev.requestId, allow: true });
      }
    } else if (ev.type === "error") log(`error(${ev.scope}${ev.code ? ` ${ev.code}` : ""}): ${ev.message.slice(0, 200)}`);
    else if (ev.type === "tool_use") log(`tool_use ${ev.name}`);
    else if (!["log", "activity", "text_delta", "tool_result", "tool_files", "mcp_status", "files", "attachment"].includes(ev.type)) {
      log(`event ${ev.type}${ev.type === "result" && !ev.ok ? ` error=${ev.error}` : ""}`);
    }
  }
  if (ev.id && replies.has(ev.id)) replies.get(ev.id)(ev);
  for (const w of [...waiters]) if (state && w.pred(state)) {
    waiters.splice(waiters.indexOf(w), 1);
    w.resolve(state);
  }
}

function send(cmd) {
  child.stdin.write(JSON.stringify(cmd) + "\n");
}

function request(cmd) {
  const id = `m${nextId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply for ${cmd.type} (${id}) within ${STEP_TIMEOUT_MS}ms`)), STEP_TIMEOUT_MS);
    replies.set(id, (ev) => {
      clearTimeout(timer);
      replies.delete(id);
      if (ev.type === "result" && !ev.ok) reject(new Error(`${cmd.type} failed: ${ev.error}`));
      else resolve(ev);
    });
    send({ ...cmd, id });
  });
}

function waitState(pred, what) {
  if (state && pred(state)) return Promise.resolve(state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}; phase=${state?.gate.phase} lastError=${state?.lastError}`)), STEP_TIMEOUT_MS);
    waiters.push({ pred, resolve: (s) => { clearTimeout(timer); resolve(s); } });
  });
}

const since = (mark, type) => events.slice(mark).filter((e) => e.type === type);
const answerSince = (mark) => since(mark, "text_delta").map((e) => e.text).join("");
const turnDone = (before) => (x) => x.hud.turnCount > before && x.gate.phase !== "running" && x.gate.phase !== "collecting";

/** Sends and waits for the collected turn; returns { state, answer, mark }. */
async function turn(cmd, what) {
  const before = state.hud.turnCount;
  const mark = events.length;
  await request({ type: "send", ...cmd });
  const s = await waitState(turnDone(before), what);
  return { state: s, answer: answerSince(mark), mark };
}

function procs() {
  const out = execFileSync("ps", ["-eo", "pid,ppid,command"], { encoding: "utf8" });
  const rows = new Map();
  for (const l of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), command: m[3], line: l });
  }
  const underApp = (pid) => {
    for (let p = pid, guard = 0; rows.has(p) && guard < 64; guard++) {
      if (/ReviewGate\.app|Electron|reviewgate-desktop/.test(rows.get(p).command)) return true;
      p = rows.get(p).ppid;
    }
    return false;
  };
  return [...rows.entries()]
    .filter(([pid, r]) => /sidecar\.mjs|stream-json/.test(r.command) && !/driver-(v2|m21|m22|m23)/.test(r.command) && !underApp(pid) && !PREEXISTING.has(pid))
    .map(([, r]) => r.line);
}
const PREEXISTING = new Set();

async function stopSidecar() {
  await request({ type: "shutdown" });
  const { code, signal } = await exited;
  assert(code === 0 && signal === null, `sidecar exit ${code} ${signal}`);
}

const settings = {
  ignorePatterns: [".omc/", ".claude/settings.local.json"],
  autoAllowTools: [],
  loadUserSettings: true,
  systemPromptAppend: "You are running inside ReviewGate. Make only the requested change and stop. Never run git commands. Answer in English.",
  claudePath: CLAUDE,
  model: MODEL,
};

const observed = {};

async function main() {
  for (const l of procs()) PREEXISTING.add(Number(/^\s*(\d+)/.exec(l)?.[1]));
  startSidecar();
  const ready = await request({ type: "hello", protocolVersion: 2, client: "test", env: { PATH: process.env.PATH ?? "" }, settings });
  assert(ready.type === "ready", "hello → ready");
  await request({ type: "open_project", path: REPO });
  let s = await waitState((x) => x.session.open && !x.session.starting && x.project !== null, "session open");
  const gdir = join(REPO, ".git");

  // ============ 1. @-mentions
  {
    const files = await request({ type: "list_files", query: "notes" });
    assert(files.type === "files" && files.items[0]?.path === "NOTES.txt", `1: list_files finds NOTES.txt first: ${JSON.stringify(files.items.slice(0, 3))}`);
    const dirHit = (await request({ type: "list_files", query: "src" })).items.find((i) => i.kind === "dir");
    assert(dirHit?.path === "src", `1: directories are listed: ${JSON.stringify(dirHit)}`);
    await request({ type: "send", text: "x", mentions: ["../etc/passwd"] }).then(
      () => assert(false, "1: a mention outside the repo must be refused"),
      (e) => assert(/invalid_mention/.test(e.message), `1: invalid_mention: ${e.message}`),
    );
    const { state: st, answer, mark } = await turn({ text: "Do not use any tools. Reply with only the first word of the referenced file, nothing else.", mentions: ["NOTES.txt"] }, "1: mention turn");
    const tools = since(mark, "tool_use").map((e) => e.name);
    assert(answer.includes("QUOKKA-4417"), `1: the mentioned file's content reached Claude: ${JSON.stringify(answer)}`);
    assert(!tools.includes("Read"), `1: native expansion (no Read call): ${JSON.stringify(tools)}`);
    const um = since(mark, "user_message")[0];
    assert(JSON.stringify(um.mentions) === JSON.stringify(["NOTES.txt"]), `1: user_message.mentions: ${JSON.stringify(um)}`);
    observed.mention = { answer: answer.trim().slice(0, 80), tools, turnCount: st.hud.turnCount };
    log(`1 mentions OK: ${observed.mention.answer}`);
  }

  // ============ 2. image attachment
  {
    const png = redPng();
    const b64 = png.toString("base64");
    await request({ type: "send", text: "x", attachments: [{ kind: "image", mediaType: "image/jpeg", dataBase64: b64 }] }).then(
      () => assert(false, "2: a PNG declared as JPEG must be refused"),
      (e) => assert(/attachment_type/.test(e.message), `2: attachment_type: ${e.message}`),
    );
    const { answer, mark } = await turn({ text: "What single colour fills this image? Reply with one word.", attachments: [{ kind: "image", mediaType: "image/png", dataBase64: b64 }] }, "2: image turn");
    assert(/red|빨/i.test(answer), `2: the image reached Claude: ${JSON.stringify(answer)}`);
    const um = since(mark, "user_message")[0];
    const ref = um.attachments?.[0];
    assert(ref?.kind === "image" && ref.mediaType === "image/png" && ref.bytes === png.length && /^[0-9a-f]{64}$/.test(ref.hash), `2: user_message.attachments: ${JSON.stringify(um.attachments)}`);
    const transcript = readFileSync(join(gdir, "reviewgate", "sessions", `${state.sessions.currentId}.ndjson`), "utf8");
    assert(transcript.includes(ref.hash) && !transcript.includes(b64.slice(0, 40)), "2: transcript keeps the hash, never the base64");
    const got = await request({ type: "attachment_get", hash: ref.hash });
    assert(got.type === "attachment" && got.dataBase64 === b64 && got.mediaType === "image/png", "2: attachment_get returns the bytes");
    observed.image = { answer: answer.trim().slice(0, 40), hash: ref.hash.slice(0, 12), bytes: ref.bytes };
    log(`2 image OK: ${observed.image.answer}`);
  }

  // ============ 3. model / effort switching
  {
    s = state;
    const models = s.session.availableModels.map((m) => m.value);
    assert(models.includes("sonnet") || models.includes("claude-sonnet-5-5"), `3: availableModels from the CLI: ${JSON.stringify(models)}`);
    const sessionBefore = s.session.sessionId;
    await request({ type: "set_model", model: "sonnet", effort: "low" });
    s = await waitState((x) => x.session.selectedModel === "sonnet" && x.session.effort === "low", "3: selected model in state");
    const { state: st, answer } = await turn({ text: "Reply with exactly: pong" }, "3: sonnet turn");
    assert(/sonnet/.test(st.session.model ?? ""), `3: the CLI reports the new model: ${st.session.model}`);
    assert(st.session.sessionId === sessionBefore, "3: same session (no restart)");
    const file = JSON.parse(readFileSync(join(gdir, "reviewgate-session.json"), "utf8"));
    assert(file.model === "sonnet" && file.effort === "low", `3: persisted per project: ${JSON.stringify(file)}`);
    observed.model = { reported: st.session.model, answer: answer.trim().slice(0, 20), available: models.length };
    await request({ type: "set_model", model: MODEL, effort: null });
    await waitState((x) => x.session.selectedModel === MODEL && x.session.effort === null, "3: back to the driver model");
    log(`3 set_model OK: ${st.session.model}`);
  }

  // ============ 4. checkpoints + rewind
  {
    const a = await turn({ text: "Remember the word mango. Then create the file a.txt containing exactly one line: alpha. Use the Write tool. Do nothing else." }, "4: turn A");
    assert(a.state.changedFiles.some((f) => f.path === "a.txt"), `4: a.txt under review: ${JSON.stringify(a.state.changedFiles.map((f) => f.path))}`);
    await request({ type: "accept_all" });
    const aContent = readFileSync(join(REPO, "a.txt"), "utf8");
    const b = await turn({ text: "Remember the word kiwi too. Then append a second line beta to a.txt and create b.txt containing exactly: bravo. Use the Edit and Write tools. Do nothing else." }, "4: turn B");
    assert(existsSync(join(REPO, "b.txt")) && readFileSync(join(REPO, "a.txt"), "utf8") !== aContent, "4: turn B changed a.txt and wrote b.txt");
    const cps = b.state.session.checkpoints;
    const turnA = cps.find((c) => c.prompt.startsWith("Remember the word mango"));
    const turnB = cps.find((c) => c.prompt.startsWith("Remember the word kiwi"));
    assert(turnA && turnB && turnB.turn === turnA.turn + 1, `4: checkpoints list both turns: ${JSON.stringify(cps)}`);
    assert(turnB.canRewindFiles && turnB.canRewindConversation && turnB.filesChanged === 2, `4: turn B rewindable, 2 files: ${JSON.stringify(turnB)}`);
    // Files back to B's start.
    const rf = await request({ type: "rewind", toTurn: turnB.turn, mode: "files" });
    assert(rf.type === "rewound" && rf.restoredFiles.includes("a.txt") && rf.restoredFiles.includes("b.txt"), `4: rewound files: ${JSON.stringify(rf)}`);
    assert(readFileSync(join(REPO, "a.txt"), "utf8") === aContent && !existsSync(join(REPO, "b.txt")), "4: a.txt back to turn A's content, b.txt gone");
    s = await waitState((x) => x.gate.phase === "idle" && x.changedFiles.length === 0, "4: review resolved by the file rewind");
    // Conversation back to before B, with the edited prompt.
    const oldChat = s.sessions.currentId;
    const mark = events.length;
    const rc = await request({ type: "rewind", toTurn: turnB.turn, mode: "conversation", editText: "Which words did I ask you to remember? Answer with the words only, comma separated. Do not use tools." });
    assert(rc.sessionId && rc.sessionId !== oldChat, `4: a new current chat: ${JSON.stringify(rc)}`);
    // The chat switch reset the HUD: wait for the fork's own turn (turnCount counts this session's turns).
    s = await waitState((x) => x.sessions.currentId === rc.sessionId && x.hud.turnCount >= 1 && x.gate.phase !== "running" && x.gate.phase !== "collecting", "4: edited turn");
    const answer = answerSince(mark);
    assert(/mango|망고/i.test(answer) && !/kiwi|키위/i.test(answer), `4: the fork knows mango, not kiwi: ${JSON.stringify(answer)}`);
    const old = s.sessions.list.find((m) => m.id === oldChat);
    assert(old && old.title.endsWith("(되돌리기 전)"), `4: the old chat stays as (되돌리기 전): ${JSON.stringify(old)}`);
    const cur = s.sessions.list.find((m) => m.id === rc.sessionId);
    assert(cur?.forkedFrom?.sessionId === oldChat && cur.forkedFrom.turn === turnB.turn, `4: forkedFrom: ${JSON.stringify(cur)}`);
    assert(s.session.sessionId === rc.sessionId, `4: the CLI runs the fork under its new id: ${s.session.sessionId}`);
    const restore = since(mark, "transcript_restore").at(-1);
    assert(restore && !restore.items.some((i) => i.kind === "user_message" && /kiwi/.test(i.text)), "4: the fork's transcript ends before turn B");
    observed.rewind = { restoredFiles: rf.restoredFiles, answer: answer.trim().slice(0, 60), oldTitle: old.title, checkpoints: s.session.checkpoints.map((c) => c.turn) };
    log(`4 rewind OK: ${observed.rewind.answer}`);
  }

  // ============ 5. compact
  {
    const before = state.hud.turnCount;
    const ctxBefore = state.hud.contextTokens;
    const mark = events.length;
    await request({ type: "compact", focus: "keep the remembered words" });
    s = await waitState(turnDone(before), "5: compact turn");
    const end = since(mark, "turn_end").at(-1);
    assert(end && end.stopReason !== "error", `5: compact turn ended: ${JSON.stringify(end)}`);
    assert(since(mark, "activity").some((e) => e.detail === "compacting" || e.detail === "compacted"), "5: compaction activity seen");
    assert(s.hud.contextTokens > 0 && s.hud.contextTokens < ctxBefore, `5: context smaller after /compact: ${ctxBefore} → ${s.hud.contextTokens}`);
    const { answer } = await turn({ text: "Which word did I ask you to remember first? One word, no tools." }, "5: after compact");
    assert(/mango|망고/i.test(answer), `5: the compacted conversation still knows mango: ${JSON.stringify(answer)}`);
    observed.compact = { contextBefore: ctxBefore, contextAfter: s.hud.contextTokens, answer: answer.trim().slice(0, 30) };
    log(`5 compact OK: ${ctxBefore} → ${s.hud.contextTokens}`);
  }

  // ============ 6. interrupt with an open permission card, then a queued send
  {
    holdPermissions = true;
    const before = state.hud.turnCount;
    const mark = events.length;
    await request({ type: "send", text: "Run this exact shell command with the Bash tool: sleep 20 && echo finished > slow.txt" });
    await waitState((x) => x.session.pendingPermission !== null, "6: permission card open");
    holdPermissions = false;
    const interrupted = request({ type: "interrupt" });
    const queued = request({ type: "send", text: "Never mind. Reply with exactly: stopped" });
    await interrupted;
    const end = since(mark, "turn_end")[0];
    assert(end?.stopReason === "interrupted", `6: turn_end interrupted before the interrupt reply: ${JSON.stringify(end)}`);
    await queued;
    s = await waitState((x) => x.hud.turnCount >= before + 2 && x.gate.phase !== "running" && x.gate.phase !== "collecting", "6: queued turn");
    assert(!existsSync(join(REPO, "slow.txt")), "6: the interrupted command never ran");
    const answer = answerSince(events.findIndex((e, i) => i >= mark && e.type === "user_message" && /Never mind/.test(e.text)));
    assert(/stopped|중단|멈/i.test(answer), `6: the queued message was answered: ${JSON.stringify(answer)}`);
    observed.interrupt = { stopReason: end.stopReason, queuedAnswer: answer.trim().slice(0, 20) };
    log("6 interrupt OK");
  }

  await stopSidecar();
  await new Promise((r) => setTimeout(r, 1500));
  const orphans = procs();
  assert(orphans.length === 0, `orphaned processes after shutdown:\n${orphans.join("\n")}`);
  log("PASS");
  console.log(JSON.stringify({ ok: true, totalMs: Date.now() - t0, model: MODEL, claudeVersion: state?.toolchain.claudeVersion ?? null, orphans: 0, observed }, null, 2));
}

main().catch(async (e) => {
  log(`FAIL: ${e.message}`);
  console.log(JSON.stringify({ ok: false, error: e.message, observed }, null, 2));
  process.exitCode = 1;
  try {
    send({ type: "shutdown" });
  } catch {}
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  if (child && child.exitCode === null) child.kill("SIGKILL");
  process.exit(1);
});
