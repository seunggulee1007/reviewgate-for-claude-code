// A stand-in for Claude Code's TUI in a PTY (terminalChat.pty.test.ts) — never the real `claude`.
// `--version` answers like the CLI; otherwise it reads the terminal in raw mode and drives ReviewGate's http hooks the way
// the TUI would, printing what it saw and what the hooks answered. Line protocol (each line ends with CR):
//   write  → UserPromptSubmit, Write notes.txt (PreToolUse / PostToolUse), Stop; prints "done"
//   git    → PreToolUse Bash `git -C <cwd> reset --hard`; prints "git <decision>"
//   /exit  → exit 0
//   other  → UserPromptSubmit, Stop; prints "context: …" / "blocked: …"
//   ESC CR → prints "meta-enter" (Shift+Enter in ReviewGate's terminal)
// Every line also prints "hex <its UTF-8 bytes>"; a resize prints "size CxR".
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  fs.writeSync(1, "2.1.325 (Claude Code)\n");
  process.exit(0);
}

const arg = (name) => {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const resumeId = arg("--resume");
const sessionId = resumeId ?? arg("--session-id") ?? "none";
const settingsText = arg("--settings") ?? "{}";
const literal = settingsText.includes("${RG_HOOK_TOKEN}");
let url = null;
try {
  url = JSON.parse(settingsText).hooks.Stop[0].hooks[0].url;
} catch {
  url = null;
}
const token = process.env.RG_HOOK_TOKEN ?? "";
const cwd = process.cwd();
const out = (s) => process.stdout.write(`${s}\r\n`);

out(`fake-claude session=${sessionId} resume=${resumeId !== undefined} term=${process.env.TERM_PROGRAM ?? ""} token=${token.length === 64 ? "yes" : "no"} literal=${literal}`);
out(`cursor=${process.env.CLAUDE_CODE_NATIVE_CURSOR ?? ""} repaint=${process.env.CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT ?? ""}`);

let chain = Promise.resolve();
let prompts = 0;
let tools = 0;

async function hook(body) {
  if (!url) return {};
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-ReviewGate-Token": token },
    body: JSON.stringify({ session_id: sessionId, cwd, transcript_path: path.join(cwd, ".no-transcript"), permission_mode: "default", ...body }),
  });
  return res.json();
}

async function prompt(text) {
  const promptId = `p${++prompts}-${Date.now()}`;
  const r = await hook({ hook_event_name: "UserPromptSubmit", prompt: text, prompt_id: promptId });
  if (r.decision === "block") out(`blocked: ${r.reason}`);
  else out(`context: ${(r.hookSpecificOutput && r.hookSpecificOutput.additionalContext) || ""}`.replace(/[\r\n]+/g, " "));
  return { promptId, blocked: r.decision === "block" };
}

async function line(text) {
  out(`hex ${Buffer.from(text, "utf8").toString("hex")}`);
  if (text === "/exit") {
    process.stdout.write("bye\r\n", () => process.exit(0));
    return;
  }
  if (text === "git") {
    const r = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `git -C ${cwd} reset --hard` }, tool_use_id: `b${++tools}` });
    out(`git ${(r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision) || "allow"}`);
    return;
  }
  const p = await prompt(text);
  if (p.blocked) return;
  if (text === "write") {
    const file = path.join(cwd, "notes.txt");
    const id = `w${++tools}`;
    const input = { file_path: file, content: "note\n" };
    await hook({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: input, tool_use_id: id, prompt_id: p.promptId });
    fs.appendFileSync(file, "note\n");
    await hook({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: input, tool_use_id: id, prompt_id: p.promptId, tool_response: { type: "create", filePath: file } });
  }
  await hook({ hook_event_name: "Stop", stop_hook_active: false });
  if (text === "write") out("done");
}

process.stdout.on("resize", () => out(`size ${process.stdout.columns}x${process.stdout.rows}`));
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const cr = buf.indexOf(0x0d);
    if (cr < 0) break;
    const raw = buf.subarray(0, cr);
    buf = buf.subarray(cr + 1);
    if (raw.length > 0 && raw[raw.length - 1] === 0x1b) {
      out("meta-enter");
      continue;
    }
    const text = raw.toString("utf8");
    chain = chain.then(() => line(text)).catch((e) => out(`error ${e && e.message}`));
  }
});
