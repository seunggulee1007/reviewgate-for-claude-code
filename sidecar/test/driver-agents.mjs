#!/usr/bin/env node
// Engine-level E2E for wave 3's agent half (docs/PROTOCOL.md §36.1–§36.4) against the real `claude` CLI.
//
//   node sidecar/test/driver-agents.mjs [/path/to/scratch/repo] [/path/to/sidecar.mjs]
//   RG_MODEL=haiku (default) — two short Haiku turns.
//
// a. two subagents in parallel (`sleep 60` / `sleep 5`): hud.waitingOnAgents counts both; stop_agent stops the slow one
//    in the middle of its Bash call — stopped by the user (node, tool_result event), while the fast one and the main
//    turn finish normally; the fast one's tool_result preview is the cleaned report (no hand-back preamble, its <usage>
//    parsed into agentUsage, its agentId into cliAgentId), its node carries prompt / model / reportPreview / cliAgentId,
//    and agent_report returns the whole cleaned report; the stopped one has none (no_report).
// b. SendMessage continues a finished subagent: the SendMessage tool_use carries continues, the card runs again
//    (resumeCount 1, resumedBy, in the foreground while SendMessage blocks), its result is cleaned too and agent_report
//    on the SendMessage answers with the continued run's report. When the model does not use SendMessage, b is
//    reported as skipped (the unit tests cover it).
// c. a second sidecar on the same repository: agent_report reads the reports back from the chat's transcript.
// The repository is created when missing (git init, main). Asserts no orphans at the end.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = process.argv[2] ?? "/tmp/rg-agents";
// The app-wide records (§36.8 cli-versions.json) go next to the scratch repository, never the user's ~/.reviewgate.
const RG_DATA = `${REPO}-rg-data`;
rmSync(RG_DATA, { recursive: true, force: true });
const sidecarEnv = { ...process.env, REVIEWGATE_DATA_DIR: process.env.REVIEWGATE_DATA_DIR || RG_DATA };
const SIDECAR = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${process.env.HOME}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "haiku";
const STEP_TIMEOUT_MS = 240_000;

const t0 = Date.now();
const log = (msg) => process.stderr.write(`[agents +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}\n`);
const assert = (cond, msg) => {
  if (!cond) {
    log(`ASSERTION FAILED: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
};
const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();

// ---------------------------------------------------------------- repo prep
if (!existsSync(join(REPO, ".git"))) {
  mkdirSync(REPO, { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "driver@example.com");
  git("config", "user.name", "driver-agents");
}
rmSync(join(REPO, ".git", "reviewgate.lock"), { force: true });
for (const f of ["reviewgate-review.json", "reviewgate-session.json", "reviewgate-transcript.ndjson"]) rmSync(join(REPO, ".git", f), { force: true });
rmSync(join(REPO, ".git", "reviewgate"), { recursive: true, force: true });
for (const r of git("for-each-ref", "--format=%(refname)", "refs/reviewgate/").split("\n").filter(Boolean)) git("update-ref", "-d", r);
writeFileSync(join(REPO, "README.md"), "# agents scratch\n");
if (git("status", "--porcelain")) {
  git("add", "-A");
  git("commit", "-q", "-m", "driver-agents: clean start");
}

// ---------------------------------------------------------------- sidecar plumbing (as driver-why)
function startSidecar(tag) {
  const sc = { state: null, nextId: 1, waiters: [], replies: new Map(), events: [], states: [] };
  sc.child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"], env: sidecarEnv });
  createInterface({ input: sc.child.stderr }).on("line", (l) => {
    if (!/:debug\]/.test(l)) process.stderr.write(`  [${tag}] ${l}\n`);
  });
  sc.exited = new Promise((resolve) => sc.child.on("exit", (code, signal) => resolve({ code, signal })));
  sc.send = (cmd) => sc.child.stdin.write(JSON.stringify(cmd) + "\n");
  createInterface({ input: sc.child.stdout }).on("line", (line) => {
    const ev = JSON.parse(line);
    if (ev.type === "state") {
      sc.state = ev.state;
      sc.states.push({ at: Date.now(), hud: ev.state.hud });
    } else {
      sc.events.push(ev);
      if (ev.type === "permission_request") {
        log(`permission_request ${ev.toolName} ${JSON.stringify(ev.input).slice(0, 80)} → allow`);
        sc.send({ type: "permission_response", requestId: ev.requestId, allow: true });
      } else if (ev.type === "tool_use") {
        log(`tool_use ${ev.name}${ev.parentToolUseId ? ` (in ${ev.parentToolUseId.slice(-6)})` : ""} ${JSON.stringify(ev.input).slice(0, 90)}${ev.continues ? ` continues=${JSON.stringify(ev.continues)}` : ""}`);
      } else if (ev.type === "tool_result" && !ev.parentToolUseId) {
        log(`tool_result ${ev.toolUseId.slice(-6)} error=${ev.isError}${ev.stoppedBy ? ` stoppedBy=${ev.stoppedBy}` : ""} ${JSON.stringify(ev.preview.slice(0, 70))}`);
      } else if (ev.type === "error") log(`error(${ev.scope}): ${ev.message}`);
    }
    if (ev.id && sc.replies.has(ev.id)) sc.replies.get(ev.id)(ev);
    for (const w of [...sc.waiters]) if (sc.state && w.pred(sc.state)) {
      sc.waiters.splice(sc.waiters.indexOf(w), 1);
      w.resolve(sc.state);
    }
  });
  sc.request = (cmd) => {
    const id = `${tag}${sc.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply for ${cmd.type} within ${STEP_TIMEOUT_MS}ms`)), STEP_TIMEOUT_MS);
      sc.replies.set(id, (ev) => {
        clearTimeout(timer);
        sc.replies.delete(id);
        if (ev.type === "result" && !ev.ok) reject(Object.assign(new Error(`${cmd.type} failed: ${ev.error}`), { code: ev.code }));
        else resolve(ev);
      });
      sc.send({ ...cmd, id });
    });
  };
  sc.refused = async (cmd) => {
    try {
      await sc.request(cmd);
    } catch (e) {
      return e.code ?? String(e.message);
    }
    assert(false, `${cmd.type} must be refused`);
  };
  sc.waitState = (pred, what) => {
    if (sc.state && pred(sc.state)) return Promise.resolve(sc.state);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}; phase=${sc.state?.gate.phase}`)), STEP_TIMEOUT_MS);
      sc.waiters.push({ pred, resolve: (s) => { clearTimeout(timer); resolve(s); } });
    });
  };
  sc.waitEvent = async (pred, what) => {
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    for (;;) {
      const ev = sc.events.find(pred);
      if (ev) return ev;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  sc.hello = () => sc.request({
    type: "hello",
    protocolVersion: 2,
    client: "test",
    env: { PATH: process.env.PATH ?? "" },
    settings: {
      ignorePatterns: [".omc/", ".claude/settings.local.json"],
      autoAllowTools: [],
      loadUserSettings: false,
      systemPromptAppend: "You are running inside ReviewGate. Do exactly what is asked and stop. Never run git commands.",
      claudePath: CLAUDE,
      model: MODEL,
    },
  });
  return sc;
}

/** The sidecar and every process under it (the `claude` CLI and its children), by pid — only ours, never another run's. */
function ourProcesses(sc) {
  const out = execFileSync("ps", ["-eo", "pid,ppid,command"], { encoding: "utf8" });
  const kids = new Map();
  for (const l of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    if (!m) continue;
    const list = kids.get(Number(m[2])) ?? [];
    list.push({ pid: Number(m[1]), line: l });
    kids.set(Number(m[2]), list);
  }
  const found = [];
  const walk = (pid) => {
    for (const k of kids.get(pid) ?? []) {
      found.push(k);
      walk(k.pid);
    }
  };
  walk(sc.child.pid);
  return [{ pid: sc.child.pid, line: `sidecar ${sc.child.pid}` }, ...found];
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function shutdown(sc) {
  const ours = ourProcesses(sc);
  await sc.request({ type: "shutdown" });
  const { code, signal } = await sc.exited;
  assert(code === 0 && signal === null, `sidecar exit ${code} ${signal}`);
  await new Promise((r) => setTimeout(r, 1500));
  const orphans = ours.filter((p) => alive(p.pid));
  // A stopped agent's own `sleep 60` is the CLI's business (it may outlive the stop by design): noted, then ended here.
  const sleeps = orphans.filter((p) => /\bsleep \d+\s*$/.test(p.line));
  for (const p of sleeps) process.kill(p.pid, "SIGTERM");
  if (sleeps.length > 0) (observed.lingeringSleeps ??= []).push(...sleeps.map((p) => p.line.trim()));
  const rest = orphans.filter((p) => !sleeps.includes(p));
  assert(rest.length === 0, `orphaned processes:\n${rest.map((p) => p.line).join("\n")}`);
}

const turnDone = (before) => (x) => x.hud.turnCount > before && x.gate.phase !== "running" && x.gate.phase !== "collecting";
const isCleaned = (text) => !text.startsWith("[Subagent hand-back]") && !/^agentId:/m.test(text) && !/<usage>/.test(text) && !text.startsWith('{"success"');
const observed = {};
let main = null;

async function run() {
  main = startSidecar("s1");
  const ready = await main.hello();
  assert(ready.type === "ready", "hello → ready");
  await main.request({ type: "open_project", path: REPO });
  let s = await main.waitState((x) => x.session.open && !x.session.starting && x.project !== null, "session open");

  // ============ a. two agents in parallel; stop the slow one; the cleaned report of the other
  let fastId;
  {
    const before = s.hud.turnCount;
    const mark = main.events.length;
    const statesMark = main.states.length;
    await main.request({
      type: "send",
      text:
        "In ONE message call the Agent tool twice in parallel (subagent_type general-purpose, model haiku). " +
        "Agent with description 'slow sleeper': run the Bash command `sleep 60` then reply 'slow done'. " +
        "Agent with description 'fast colors': run the Bash command `sleep 5` then reply with a markdown list of exactly three colors, one per line. " +
        "After both agents returned, reply with one short line. Do nothing else.",
    });
    const agents = await main.waitState((x) => x.hud.agents.filter((a) => a.id !== a.toolUseId).length >= 2, "two agents with task ids");
    const slow = agents.hud.agents.find((a) => /slow/i.test(a.description) || /sleep 60/.test(a.prompt ?? ""));
    const fast = agents.hud.agents.find((a) => a !== slow);
    assert(slow && fast, `slow / fast agents: ${JSON.stringify(agents.hud.agents.map((a) => [a.description, a.prompt?.slice(0, 40)]))}`);
    fastId = fast.toolUseId;
    await main.waitEvent((e, i) => i >= mark && e.type === "tool_use" && e.name === "Bash" && e.parentToolUseId === slow.toolUseId, "the slow agent's Bash call");
    await new Promise((r) => setTimeout(r, 1500));
    const waiting = main.states.slice(statesMark).map((x) => x.hud.waitingOnAgents).filter(Boolean);
    assert(waiting.some((w) => w.count === 2), `waitingOnAgents counted both: ${JSON.stringify(waiting.slice(-3))}`);
    const tStop = Date.now();
    const stopReply = await main.request({ type: "stop_agent", toolUseId: slow.toolUseId });
    const stopMs = Date.now() - tStop;
    assert(stopReply.type === "result" && stopReply.ok === true, `stop_agent → ok: ${JSON.stringify(stopReply)}`);
    const afterStop = main.state.hud.agents.find((a) => a.toolUseId === slow.toolUseId);
    assert(afterStop?.status === "stopped" && afterStop.stoppedBy === "user", `slow node stopped by the user: ${JSON.stringify(afterStop)}`);
    assert(main.state.gate.phase === "running", `the turn goes on: ${main.state.gate.phase}`);
    const slowResult = await main.waitEvent((e, i) => i >= mark && e.type === "tool_result" && e.toolUseId === slow.toolUseId, "the slow agent's result");
    assert(slowResult.isError === true && slowResult.stoppedBy === "user", `slow tool_result carries stoppedBy: ${JSON.stringify(slowResult)}`);
    assert(await main.refused({ type: "stop_agent", toolUseId: slow.toolUseId }) === "not_running", "a second stop_agent is not_running");
    s = await main.waitState(turnDone(before), "the turn ends");
    await new Promise((r) => setTimeout(r, 300));
    const fastResult = main.events.find((e, i) => i >= mark && e.type === "tool_result" && e.toolUseId === fast.toolUseId);
    assert(fastResult && fastResult.isError === false, `fast agent completed: ${JSON.stringify(fastResult)}`);
    assert(isCleaned(fastResult.preview), `the preview is the cleaned report: ${JSON.stringify(fastResult.preview)}`);
    assert(fastResult.agentUsage && fastResult.agentUsage.tokens > 0 && fastResult.agentUsage.durationMs > 0 && fastResult.agentUsage.toolUses >= 1, `agentUsage parsed: ${JSON.stringify(fastResult.agentUsage)}`);
    assert(typeof fastResult.cliAgentId === "string" && fastResult.cliAgentId.length > 0, `cliAgentId parsed: ${fastResult.cliAgentId}`);
    const call = main.events.find((e) => e.type === "tool_use" && e.id === fast.toolUseId);
    const node = s.hud.agents.find((a) => a.toolUseId === fast.toolUseId);
    assert(node && node.status === "completed" && node.cliAgentId === fastResult.cliAgentId && typeof node.reportPreview === "string" && node.reportPreview.length > 0, `fast node: ${JSON.stringify(node)}`);
    assert(node.prompt === call.input.prompt.slice(0, 8000) && node.model === (call.input.model ?? null), `prompt / model on the node: ${JSON.stringify([node.prompt?.slice(0, 60), node.model])}`);
    assert(node.tokens === fastResult.agentUsage.tokens, `the <usage> numbers are the node's final ones: ${node.tokens} vs ${fastResult.agentUsage.tokens}`);
    const report = await main.request({ type: "agent_report", toolUseId: fast.toolUseId });
    assert(report.type === "agent_report" && isCleaned(report.text) && report.text.startsWith(fastResult.preview.slice(0, 50)), `agent_report text: ${JSON.stringify(report.text)}`);
    const lines = report.text.split("\n").filter((l) => l.trim());
    assert(!lines.every((l) => l.startsWith("  ")), `the harness indentation is gone: ${JSON.stringify(report.text)}`);
    assert(report.prompt === call.input.prompt && report.model === (call.input.model ?? null) && JSON.stringify(report.usage) === JSON.stringify(fastResult.agentUsage) && report.truncated === false, `agent_report fields: ${JSON.stringify({ ...report, text: undefined })}`);
    assert(await main.refused({ type: "agent_report", toolUseId: slow.toolUseId }) === "no_report", "the stopped agent has no report");
    assert(await main.refused({ type: "agent_report", toolUseId: "toolu_nope" }) === "unknown_agent", "unknown_agent");
    assert(s.hud.waitingOnAgents === null, `waitingOnAgents null between turns: ${JSON.stringify(s.hud.waitingOnAgents)}`);
    const slowNode = s.hud.agents.find((a) => a.toolUseId === slow.toolUseId);
    assert(slowNode.status === "stopped" && slowNode.stoppedBy === "user", `slow stays stopped by the user: ${JSON.stringify(slowNode)}`);
    observed.stop = {
      stopMs,
      waitingMax: waiting.reduce((m, w) => Math.max(m, w.count), 0),
      slowResult: { isError: slowResult.isError, stoppedBy: slowResult.stoppedBy, preview: slowResult.preview },
      fastPreview: fastResult.preview.slice(0, 120),
      agentUsage: fastResult.agentUsage,
      cliAgentId: fastResult.cliAgentId,
      model: node.model,
      reportChars: report.text.length,
      mainTurnOk: s.hud.turnCount === before + 1,
    };
    log(`a stop + report OK: ${JSON.stringify(observed.stop)}`);
  }

  // ============ b. SendMessage continues a finished agent
  let sendId = null;
  {
    const before = s.hud.turnCount;
    const mark = main.events.length;
    const statesMark = main.states.length;
    await main.request({
      type: "send",
      text:
        "Step 1: call the Agent tool once (subagent_type general-purpose, model haiku, description 'helper') telling it: 'Reply with the word ready. Use no tools.' " +
        "Step 2: after it returns, use the SendMessage tool to send that same agent (to: the agentId from its result) the message: 'Now reply with the word again. Use no tools.' " +
        "Step 3: then reply 'ok' and stop.",
    });
    s = await main.waitState(turnDone(before), "the continuation turn ends");
    await new Promise((r) => setTimeout(r, 300));
    const agentCall = main.events.find((e, i) => i >= mark && e.type === "tool_use" && (e.name === "Agent" || e.name === "Task") && !e.parentToolUseId);
    const sm = main.events.find((e, i) => i >= mark && e.type === "tool_use" && e.name === "SendMessage" && !e.parentToolUseId);
    if (!agentCall || !sm) {
      observed.continuation = `skipped: the model made no ${!agentCall ? "Agent" : "SendMessage"} call (session.agentDetails.test.ts covers §36.3)`;
      log(`b ${observed.continuation}`);
    } else {
      sendId = sm.id;
      assert(sm.continues && sm.continues.agentToolUseId === agentCall.id && sm.continues.agentType === "general-purpose", `SendMessage continues: ${JSON.stringify(sm.continues)} (to ${sm.input.to})`);
      const resumed = main.states.slice(statesMark).map((x) => x.hud.agents.find((a) => a.toolUseId === agentCall.id)).filter((a) => a && a.resumeCount === 1 && a.status === "running");
      assert(resumed.length > 0, "the card ran again with resumeCount 1");
      assert(resumed.every((a) => a.resumedBy === sm.id && a.isBackground === false), `resumedBy / foreground while SendMessage blocks: ${JSON.stringify(resumed[0])}`);
      const waits = main.states.slice(statesMark).map((x) => x.hud.waitingOnAgents).filter(Boolean);
      assert(waits.some((w) => w.longest.toolUseId === agentCall.id), `waitingOnAgents during the continuation: ${JSON.stringify(waits.slice(-2))}`);
      const smResult = main.events.find((e, i) => i >= mark && e.type === "tool_result" && e.toolUseId === sm.id);
      assert(smResult && smResult.isError === false && isCleaned(smResult.preview) && !smResult.preview.includes("[Subagent hand-back]"), `the SendMessage result is cleaned: ${JSON.stringify(smResult?.preview)}`);
      const final = s.hud.agents.find((a) => a.toolUseId === agentCall.id);
      assert(final && final.status === "completed" && final.resumeCount === 1, `the card after the continuation: ${JSON.stringify(final)}`);
      const rep = await main.request({ type: "agent_report", toolUseId: sm.id });
      assert(rep.text.length > 0 && isCleaned(rep.text) && rep.prompt === sm.input.message, `agent_report on the SendMessage: ${JSON.stringify(rep)}`);
      observed.continuation = { to: sm.input.to, continues: sm.continues, resumedStates: resumed.length, smPreview: smResult.preview.slice(0, 80), agentUsage: smResult.agentUsage ?? null, report: rep.text.slice(0, 80) };
      log(`b continuation OK: ${JSON.stringify(observed.continuation)}`);
    }
  }
  const costUSD = Number(main.state.hud.sessionCostUSD.toFixed(4));
  const claudeVersion = main.state.toolchain.claudeVersion;
  await shutdown(main);

  // ============ c. a new sidecar reads the reports back from the transcript
  {
    const again = startSidecar("s2");
    main = again;
    await again.hello();
    await again.request({ type: "open_project", path: REPO });
    await again.waitState((x) => x.project !== null && !x.session.starting, "project open again");
    const restored = again.events.find((e) => e.type === "transcript_restore");
    assert(restored && restored.items.every((r) => !("report" in r)), "transcript_restore carries no report");
    const rep = await again.request({ type: "agent_report", toolUseId: fastId });
    assert(isCleaned(rep.text) && rep.text.length > 0 && rep.usage && rep.usage.tokens > 0, `agent_report from the transcript: ${JSON.stringify(rep)}`);
    if (sendId) {
      const cont = await again.request({ type: "agent_report", toolUseId: sendId });
      assert(cont.text.length > 0, `the continuation's report from the transcript: ${JSON.stringify(cont)}`);
    }
    observed.transcript = { fastChars: rep.text.length, restoredRows: restored.items.length };
    log(`c transcript OK: ${JSON.stringify(observed.transcript)}`);
    await shutdown(again);
  }
  log("PASS");
  console.log(JSON.stringify({ ok: true, totalMs: Date.now() - t0, model: MODEL, claudeVersion, sessionCostUSD: costUSD, observed }, null, 2));
}

run().catch(async (e) => {
  log(`FAIL: ${e.message}`);
  console.log(JSON.stringify({ ok: false, error: e.message, observed }, null, 2));
  process.exitCode = 1;
  try {
    main?.send({ type: "shutdown" });
  } catch {}
  if (main) await Promise.race([main.exited, new Promise((r) => setTimeout(r, 5000))]);
  if (main && main.child.exitCode === null) main.child.kill("SIGKILL");
  process.exit(1);
});
