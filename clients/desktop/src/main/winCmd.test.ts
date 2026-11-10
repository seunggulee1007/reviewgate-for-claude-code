import { describe, expect, it } from "vitest";
import { cmdInvocation, escapeCmdArg } from "./winCmd.js";

/**
 * A model of what Windows does to the `/c "<line>"` of `cmd.exe /d /s /c`:
 * round 1 = cmd.exe parsing the line (%VAR% expansion, then ^ escapes / quotes / operators);
 * for a batch target, round 2 = the batch's `"..." %*` line being parsed again (no % re-expansion of %*);
 * then CommandLineToArgvW in the final program. Returns null when the line would run something else
 * (an operator outside quotes, or a %VAR% that would expand).
 */
function simulate(line: string, batch: boolean, env: Record<string, string> = { PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\a" }): string[] | null {
  // Round 1 — cmd.exe: %name% expands when `name` is a defined variable (names containing ^ do not match one).
  for (const m of line.matchAll(/%([^%]+)%/g)) if (Object.hasOwn(env, m[1]!.toUpperCase())) return null;
  const s1 = carets(line);
  if (s1 === null) return null;
  // The program: the leading quoted path; the rest is what a batch file sees as %*.
  const m = /^"([^"]*)"(.*)$/s.exec(s1);
  if (!m) return null;
  let rest = m[2]!;
  if (batch) {
    // Round 2 — the shim's `"…\\Code.exe" "…\\cli.js" %*` line is parsed again (%* itself is not re-expanded).
    const r = carets(rest);
    if (r === null) return null;
    rest = r;
  }
  return [m[1]!, ...argv(rest)];
}

/** One cmd parse: ^x → x outside quotes, a quote toggles quoting, an operator outside quotes = injection (null). */
function carets(s: string): string | null {
  let out = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (!quoted && c === "^") {
      out += s[i + 1] ?? "";
      i++;
      continue;
    }
    if (c === '"') quoted = !quoted;
    else if (!quoted && /[&|<>]/.test(c)) return null;
    out += c;
  }
  return out;
}

/** CommandLineToArgvW. */
function argv(s: string): string[] {
  const args: string[] = [];
  let cur = "";
  let inQ = false;
  let started = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\") {
      let n = 0;
      while (s[i] === "\\") (n++, i++);
      if (s[i] === '"') {
        cur += "\\".repeat(Math.floor(n / 2));
        if (n % 2 === 1) cur += '"';
        else inQ = !inQ;
        started = true;
      } else {
        cur += "\\".repeat(n);
        i--;
      }
    } else if (c === '"') {
      inQ = !inQ;
      started = true;
    } else if (c === " " && !inQ) {
      if (cur || started) args.push(cur);
      cur = "";
      started = false;
    } else cur += c;
  }
  if (cur || started) args.push(cur);
  return args;
}

const CODE = "C:\\Users\\홍 길동\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd";
const inner = (args: string[]) => {
  const last = args[args.length - 1]!;
  expect(last.startsWith('"') && last.endsWith('"')).toBe(true);
  return last.slice(1, -1); // /s strips the outer quotes
};

describe("cmdInvocation", () => {
  it("runs cmd.exe /d /s /c with one quoted line", () => {
    const inv = cmdInvocation(CODE, ["-g", "C:\\a.ts:3"]);
    expect(inv.file).toBe("cmd.exe");
    expect(inv.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
  });

  const paths = [
    "C:\\Users\\a b\\My Project\\src\\main.ts:12",
    "C:\\work\\R&D\\a.ts",
    "C:\\work\\a^b\\c.ts",
    "C:\\work\\100%\\%PATH%\\a.ts",
    "C:\\work\\%USERPROFILE%x\\a.ts",
    "C:\\사용자\\홍 길동\\프로젝트\\파일.ts:7",
    "C:\\work\\(x86) [a] {b};c,d!e`f\\a.ts",
    "C:\\work\\a|b>c<d\\e.ts",
    "C:\\trailing\\",
  ];
  for (const p of paths) {
    it(`passes ${JSON.stringify(p)} through unchanged (batch target)`, () => {
      const line = inner(cmdInvocation(CODE, ["-g", p]).args);
      const argv = simulate(line, true);
      expect(argv).not.toBeNull();
      expect(argv!.slice(1)).toEqual(["-g", p]);
    });
    it(`passes ${JSON.stringify(p)} through unchanged (exe target)`, () => {
      const line = inner(cmdInvocation("C:\\Program Files\\x\\tool.exe", [p]).args);
      const argv = simulate(line, false);
      expect(argv).not.toBeNull();
      expect(argv!.slice(1)).toEqual([p]);
    });
  }

  it("keeps the program path (spaces, Korean) as the first word", () => {
    const argv = simulate(inner(cmdInvocation(CODE, ["x"]).args), true);
    expect(argv![0]).toBe(CODE);
  });

  it("the old naive quoting was injectable (regression guard)", () => {
    // editor.ts before quoted each argument once: cmd.exe still expanded %VAR% inside the quotes.
    expect(simulate(`"${CODE}" "C:\\work\\%PATH%\\a.ts"`, true)).toBeNull();
    expect(escapeCmdArg("a&b", true)).toBe('^^^"a^^^&b^^^"');
    expect(escapeCmdArg('say "hi"\\', false)).toBe('^"say^ \\^"hi\\^"\\\\^"');
  });
});
