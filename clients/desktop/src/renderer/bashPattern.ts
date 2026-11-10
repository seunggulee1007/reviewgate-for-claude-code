/**
 * Permission card helpers (pure, unit-tested): the "Always allow in this project" pattern derived from a
 * Bash command (exact program + subcommand, Claude-style `Bash(prog sub:*)` — docs/PROTOCOL.md §10 / §19.3),
 * and the one-line risk summary (network, deletion, outside the project, git history).
 */
import type { PermissionRequest } from "@reviewgate/engine";

/** Tokens split on whitespace with simple '…' / "…" quoting; null when a quote is left open. */
export function shellWords(command: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let has = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || cur.length > 0) out.push(cur);
      cur = "";
      has = false;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (quote) return null;
  if (has || cur.length > 0) out.push(cur);
  return out;
}

/** Programs never offered as "always allow": shells, privilege, interpreters without a script, destructive tools. */
const NEVER = new Set(["sudo", "su", "doas", "sh", "bash", "zsh", "fish", "dash", "ksh", "pwsh", "powershell", "cmd", "eval", "exec", "xargs", "env", "nohup", "time", "watch", "rm", "rmdir", "dd", "mkfs", "shred", "chmod", "chown", "chgrp", "kill", "killall", "pkill", "curl", "wget", "ssh", "scp", "sftp", "nc", "ncat", "telnet"]);
/** Interpreters: allowed only with a named script / subcommand (`node build.js`), never bare (`node -e …`). */
const INTERPRETERS = new Set(["node", "deno", "bun", "python", "python3", "py", "ruby", "perl", "php", "java", "osascript", "lua", "Rscript"]);
const PROGRAM = /^[A-Za-z0-9._\/-]+$/;
const SUBCOMMAND = /^[A-Za-z0-9._:\/@+=-]+$/;

/**
 * `npm test -- --watch` → `Bash(npm test:*)`, `pytest -x` → `Bash(pytest:*)`. Null when the command is not one simple
 * command (chains, pipes, redirections, substitutions, env assignments) or the program is never offered.
 */
export function deriveAllowPattern(command: string): string | null {
  const line = command.trim();
  if (line.length === 0 || line.length > 2000) return null;
  if (/[;&|<>`$(){}\n\r\\*?[\]]/.test(line)) return null;
  const words = shellWords(line);
  if (!words || words.length === 0) return null;
  const [prog, sub] = words as [string, string | undefined];
  if (!PROGRAM.test(prog) || prog.includes("=")) return null;
  const base = prog.split("/").pop()!;
  if (NEVER.has(base)) return null;
  const hasSub = sub !== undefined && !sub.startsWith("-") && SUBCOMMAND.test(sub) && sub.length <= 80;
  if (INTERPRETERS.has(base) && !hasSub) return null;
  return hasSub ? `Bash(${prog} ${sub}:*)` : `Bash(${prog}:*)`;
}

/** Appends `pattern` to a "one per line" text unless it is already there. */
export function addPatternLine(text: string | undefined, pattern: string): string {
  const lines = (text ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.includes(pattern)) return lines.join("\n");
  return [...lines, pattern].join("\n");
}

export type PermissionRisk = "network" | "deletion" | "outside" | "history";

const NETWORK_PROGRAMS = /(^|[\s;&|(])(curl|wget|ssh|scp|sftp|rsync|nc|ncat|telnet|ftp|gh|docker\s+(pull|push|login)|git\s+(push|pull|fetch|clone|ls-remote)|npm\s+(i|install|ci|add|publish|update)|pnpm\s+(i|install|add|publish|update)|yarn(\s+(add|install|publish))?|pip3?\s+install|cargo\s+(install|publish|update)|go\s+(get|install)|brew\s+(install|upgrade)|apt(-get)?\s+install)(?=$|[\s;&|)])/;
const DELETION = /(^|[\s;&|(])(rm|rmdir|unlink|shred|truncate|git\s+(rm|clean)|find\b[^;&|]*\s-delete)(?=$|[\s;&|)])|(^|[^>])>\s*[^\s>&]/;
const HISTORY = /(^|[\s;&|(])git\s+(reset|rebase|commit\s+[^;&|]*--amend|push\s+[^;&|]*(--force|-f\b|--force-with-lease)|filter-branch|filter-repo|reflog\s+(expire|delete)|branch\s+[^;&|]*-D\b|tag\s+[^;&|]*-d\b|update-ref|gc\s+[^;&|]*--prune|replace)(?=$|[\s;&|)])/;

const normalize = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** True when `path` (absolute, `~`, or with `..` above the root) points outside `root`. */
function outside(path: string, root: string | null | undefined): boolean {
  const p = normalize(path.replace(/^['"]|['"]$/g, ""));
  if (p.startsWith("~")) return true;
  const abs = p.startsWith("/") || /^[A-Za-z]:\//.test(p);
  if (!abs) {
    let depth = 0;
    for (const part of p.split("/")) {
      if (part === "..") depth--;
      else if (part !== "." && part !== "") depth++;
      if (depth < 0) return true;
    }
    return false;
  }
  if (!root) return true;
  const r = normalize(root);
  const cmp = (s: string) => (/^[A-Za-z]:\//.test(r) ? s.toLowerCase() : s);
  if (["/dev/null", "/tmp", "/private/tmp"].some((x) => p === x || p.startsWith(x + "/"))) return false;
  return !(cmp(p) === cmp(r) || cmp(p).startsWith(cmp(r) + "/"));
}

/** The flags for one permission request, in a fixed order. */
export function permissionRisks(request: Pick<PermissionRequest, "toolName" | "input" | "file">, root: string | null | undefined): PermissionRisk[] {
  const out = new Set<PermissionRisk>();
  const tool = request.toolName;
  const command = typeof request.input["command"] === "string" ? (request.input["command"] as string) : null;
  if (tool === "WebFetch" || tool === "WebSearch") out.add("network");
  if (command !== null) {
    if (NETWORK_PROGRAMS.test(command) || /\bhttps?:\/\//.test(command)) out.add("network");
    if (DELETION.test(command.replace(/\d?>{1,2}\s*\/dev\/null/g, " "))) out.add("deletion");
    if (HISTORY.test(command)) out.add("history");
    const words = shellWords(command.replace(/[;&|<>()]/g, " ")) ?? command.split(/\s+/);
    for (const w of words) {
      const path = w.includes("=") && !w.startsWith("/") ? w.slice(w.indexOf("=") + 1) : w;
      if (/^(\/|~|[A-Za-z]:[\\/])/.test(path) || /(^|\/)\.\.(\/|$)/.test(path)) {
        if (/^https?:/.test(path)) continue;
        if (outside(path, root)) {
          out.add("outside");
          break;
        }
      }
    }
  }
  const file = request.file ?? (typeof request.input["file_path"] === "string" ? (request.input["file_path"] as string) : undefined);
  if (file && outside(file, root)) out.add("outside");
  return (["network", "deletion", "outside", "history"] as PermissionRisk[]).filter((k) => out.has(k));
}
