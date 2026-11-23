// MARK: code-nav — docs/PROTOCOL.md §62: "go to definition" and "find references" from the diff / the code browser, without a
// language server: one `git grep` for the word, then per-language definition patterns chosen by the file's extension, ranked
// by what the file the user clicked in imports and where it lives.
import { spawn } from "node:child_process";
import { cpus } from "node:os";
import { posix } from "node:path";
import { CommandRefused } from "../errors.js";
import { getGitPath, runGit, shadowArgs } from "../git/exec.js";
import { repoRelativeInside } from "../platform/paths.js";
import type { DefinitionCandidate, DefinitionKind, ReferenceHit } from "../protocol.js";
import { readProjectFile } from "./browse.js";

/** `find_definition` sends at most this many candidates, best first. */
export const DEFINITION_MAX = 50;
/** `find_references` default and cap of `limit`. */
export const REFERENCES_DEFAULT_LIMIT = 500;
export const REFERENCES_MAX_LIMIT = 2_000;
/** A symbol longer than this is refused `bad_symbol`. */
export const NAV_SYMBOL_MAX = 200;
/** Time budgets: what was found until then is the answer (`timedOut`). */
export const DEFINITION_TIMEOUT_MS = 10_000;
export const REFERENCES_TIMEOUT_MS = 15_000;
/** `find_definition` reads at most this many lines holding the word before it ranks them (then `truncated`). */
export const DEFINITION_SCAN_MAX = 100_000;
/** Characters of a line a preview carries (a window around the symbol on a longer one). */
export const NAV_PREVIEW_MAX = 200;
/** A longer line (a minified bundle) is never taken for a definition. */
const LONG_LINE = 2_000;

export type Lang = "java" | "kotlin" | "js" | "vue" | "jsp" | "tld" | "swift" | "python" | "go";
const LANG_BY_EXT: Record<string, Lang> = {
  java: "java", kt: "kotlin", kts: "kotlin",
  js: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js", mts: "js", cts: "js",
  vue: "vue", jsp: "jsp", jspf: "jsp", jspx: "jsp", tag: "jsp", tagx: "jsp", tld: "tld",
  swift: "swift", py: "python", pyi: "python", go: "go",
};
/** Language families: a candidate in the clicked file's family ranks above one in another (JSP is Java and JS). */
const FAMILY: Record<Lang, readonly string[]> = {
  java: ["jvm"], kotlin: ["jvm"], jsp: ["jvm", "web"], tld: ["jvm"], js: ["web"], vue: ["web"], swift: ["swift"], python: ["python"], go: ["go"],
};
const DEFINITION_PATHSPECS = Object.keys(LANG_BY_EXT).map((ext) => `*.${ext}`);

const IDENT = /^[A-Za-z_$][\w$]*$/;
const FQN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const KEBAB = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/;
const TAG = /^[A-Za-z_][\w-]*:[A-Za-z_][\w-]*$/;
const PATH = /^(?:\.{1,2}\/|\/)?[\w$@.-]+(?:\/[\w$@.-]+)*$/;
const FILE_EXT = /\.(?:jsp|jspf|jspx|tag|tagx|vue|jsx?|tsx?|mjs|cjs|html?|css|scss|less|xml|json|properties|ya?ml)$/i;

/** What a symbol asks for: a word to grep (with its definition patterns) and / or files to look up by name. */
type Query =
  | { form: "ident"; word: string }
  | { form: "fqn"; word: string; fqnPath: string }
  | { form: "kebab"; word: string }
  | { form: "tag"; word: string; prefix: string; name: string }
  | { form: "path"; word: string; path: string };

/** The symbol's form, or `bad_symbol` (an identifier-ish token: identifier, a.b.C, kebab-name, prefix:tag or a file path). */
export function parseSymbol(raw: unknown): Query {
  const symbol = typeof raw === "string" ? raw.trim() : "";
  if (!symbol || symbol.length > NAV_SYMBOL_MAX) throw new CommandRefused("bad_symbol", { code: "bad_symbol" });
  if (IDENT.test(symbol)) return { form: "ident", word: symbol };
  if (TAG.test(symbol)) {
    const [prefix, name] = symbol.split(":") as [string, string];
    return { form: "tag", word: symbol, prefix, name };
  }
  if (PATH.test(symbol) && (symbol.includes("/") || FILE_EXT.test(symbol))) return { form: "path", word: symbol, path: symbol };
  if (FQN.test(symbol)) return { form: "fqn", word: symbol, fqnPath: symbol.split(".").join("/") };
  if (KEBAB.test(symbol)) return { form: "kebab", word: symbol };
  throw new CommandRefused("bad_symbol", { code: "bad_symbol" });
}

// ---------------------------------------------------------------- definition patterns

export type Rule = {
  re: RegExp;
  kind: DefinitionKind | ((m: RegExpExecArray, line: string) => DefinitionKind);
  /** Keyword-backed (`class X`, `fun x`) vs a shape that can also be something else (a local, a call's line). */
  strong: boolean | ((m: RegExpExecArray, line: string) => boolean);
  /** False: not a definition after all (a keyword where a type was expected, …). */
  ok?: (m: RegExpExecArray, line: string) => boolean;
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Words that stand where a Java type would but make the line something else (a statement, a modifier, a JS line in a JSP).
const NOT_A_TYPE = new Set(["return", "new", "throw", "else", "case", "yield", "await", "package", "import", "assert", "goto", "do", "try", "finally",
  "public", "protected", "private", "static", "final", "abstract", "synchronized", "native", "default", "strictfp", "transient", "volatile", "sealed",
  "var", "let", "const", "function", "async", "export", "typeof", "delete"]);
const JMOD = String.raw`(?<mods>(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp|transient|volatile|sealed|non-sealed)\s+|@[\w$.]+(?:\([^)]*\))?\s+)*)`;
const JTYPE = String.raw`[\w$][\w$.]*(?:\s*<[^()=;]*>)?(?:\s*\[\s*\])*`;
const TSMOD = String.raw`(?:(?:static|async|get|set|public|private|protected|readonly|override|abstract|declare)\s+)*`;
const JS_FN_VALUE = /^\s*(?:async\s+)?(?:function\b|(?:\([^)]*\)|[\w$]+)\s*=>)/;

/** Any identifier: what the symbol index (§65) puts where a word would be. */
const ANY_IDENT = String.raw`[A-Za-z_$][\w$]*`;

/**
 * The rules of each language for `word`, the symbol captured as group `s` (indices: flag `d`). `null`: any identifier — the
 * same patterns read every declaration of a line for the symbol index (§65); `jspTags` are the JSP-only tag rules.
 */
export function rulesFor(word: string | null): Record<Lang, Rule[]> & { jspTags: Rule[] } {
  const S = String.raw`(?<![\w$])(?<s>${word === null ? ANY_IDENT : escapeRe(word)})(?![\w$])`;
  const rx = (src: string): RegExp => new RegExp(src, "d");
  const upper = (m: RegExpExecArray): boolean => /^[A-Z]/.test(m.groups?.s ?? "");
  const allCaps = (m: RegExpExecArray): boolean => /^[A-Z][A-Z0-9_]*$/.test(m.groups?.s ?? "");
  const typeOk = (m: RegExpExecArray): boolean => !NOT_A_TYPE.has((m.groups?.t ?? "").trim());
  const hasMods = (m: RegExpExecArray): boolean => (m.groups?.mods ?? "").trim() !== "";

  const java: Rule[] = [
    { re: rx(String.raw`@interface\s+${S}`), kind: "annotation", strong: true },
    { re: rx(String.raw`\b(?<k>class|interface|enum|record)\s+${S}`), kind: (m) => m.groups!.k as DefinitionKind, strong: true },
    { re: rx(String.raw`^\s*${JMOD}(?:<[^>]*>\s+)?(?<t>${JTYPE})\s+${S}\s*\(`), kind: "method", strong: true, ok: typeOk },
    {
      re: rx(String.raw`^\s*${JMOD}${S}\s*\([^;]*$`), kind: "constructor",
      strong: (m, line) => hasMods(m) || /\{\s*$/.test(line), ok: upper,
    },
    { re: rx(String.raw`^\s*${JMOD}(?<t>${JTYPE})\s+${S}\s*(?:=(?!=)|;|,|$)`), kind: "field", strong: hasMods, ok: typeOk },
    { re: rx(String.raw`^\s*${S}\s*(?:\(.*\))?\s*(?:[,;{]\s*)?(?:\/\/.*)?$`), kind: "constant", strong: false, ok: allCaps },
  ];
  const kotlin: Rule[] = [
    {
      re: rx(String.raw`\b(?<k>(?:(?:enum|data|sealed|annotation|value|inline|abstract|open|inner|private|internal|public|protected|expect|actual|companion)\s+)*(?:class|interface|object))\s+${S}`),
      kind: (m) => {
        const k = m.groups!.k!;
        return /\binterface$/.test(k) ? "interface" : /\benum\s+class$/.test(k) ? "enum" : /\bobject$/.test(k) ? "object" : "class";
      },
      strong: true,
    },
    { re: rx(String.raw`\bfun\s+(?:<[^>]*>\s*)?(?:[\w$.]+(?:<[^>]*>)?\??\.)?${S}\s*[(<]`), kind: "function", strong: true },
    { re: rx(String.raw`\b(?:val|var)\s+(?:<[^>]*>\s*)?(?:[\w$.]+(?:<[^>]*>)?\??\.)?${S}(?=\s*[:=),]|\s*$|\s+by\b)`), kind: "property", strong: true },
    { re: rx(String.raw`\btypealias\s+${S}`), kind: "type", strong: true },
    java[java.length - 1]!, // an enum entry
  ];
  const js: Rule[] = [
    { re: rx(String.raw`\bfunction(?:\s*\*\s*|\s+)${S}\s*[(<]`), kind: "function", strong: true },
    {
      re: rx(String.raw`\b(?:const|let|var)\s+${S}\s*(?::[^=]+)?=(?![=>])`),
      kind: (m, line) => (JS_FN_VALUE.test(line.slice(m.index + m[0].length)) ? "function" : "variable"), strong: true,
    },
    { re: rx(String.raw`\bclass\s+${S}`), kind: "class", strong: true },
    { re: rx(String.raw`\binterface\s+${S}`), kind: "interface", strong: true },
    { re: rx(String.raw`\btype\s+${S}\s*(?:<[^>]*>)?\s*=`), kind: "type", strong: true },
    { re: rx(String.raw`\benum\s+${S}`), kind: "enum", strong: true },
    { re: rx(String.raw`\b(?:namespace|module)\s+${S}\s*\{`), kind: "module", strong: true },
    { re: rx(String.raw`\b(?:module\.)?exports\.${S}\s*=(?!=)`), kind: "variable", strong: true },
    { re: rx(String.raw`^\s*name\s*:\s*['"]${S}['"]`), kind: "component", strong: true },
    // `name(params) {` — the params with one level of parentheses, so `foo(function () {` (a call taking a callback) is not one.
    { re: rx(String.raw`^\s*${TSMOD}\*?\s*${S}\s*(?:<[^>]*>)?\s*\((?:[^()]|\([^()]*\))*\)\s*(?::\s*[^{]+)?\{\s*(?:\/\/.*)?$`), kind: "method", strong: true },
    { re: rx(String.raw`(?:^|[\s{,])['"]?${S}['"]?\s*:\s*(?:async\s+)?(?:function\b|(?:\([^)]*\)|[\w$]+)\s*=>)`), kind: "method", strong: true },
    { re: rx(String.raw`^\s*(?:(?:static|readonly|public|private|protected|override|declare)\s+)+${S}\s*[?!]?\s*[:=;]`), kind: "property", strong: true },
    { re: rx(String.raw`^\s*${TSMOD}${S}\s*\??\s*(?:<[^>]*>)?\s*\(.*\)\s*:\s*[^;{]+;\s*$`), kind: "method", strong: false },
    { re: rx(String.raw`^\s*${S}\s*[?!]?\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[\w$]+)\s*=>`), kind: "method", strong: false },
    { re: rx(String.raw`\b(?:const|let|var)\s*[{[][^=]*${S}[^=]*[}\]]\s*=(?!=)`), kind: "variable", strong: false },
    { re: rx(String.raw`^\s*['"]?${S}['"]?\s*\??\s*:(?!:)\s*\S`), kind: "property", strong: false },
  ];
  const jspOwn: Rule[] = [
    { re: rx(String.raw`<c:set\b[^>]*\bvar\s*=\s*["']${S}["']`), kind: "variable", strong: true },
    { re: rx(String.raw`<jsp:useBean\b[^>]*\bid\s*=\s*["']${S}["']`), kind: "variable", strong: true },
    { re: rx(String.raw`<%@\s*attribute\b[^>]*\bname\s*=\s*["']${S}["']`), kind: "property", strong: true },
    { re: rx(String.raw`<%@\s*variable\b[^>]*\bname-given\s*=\s*["']${S}["']`), kind: "variable", strong: true },
  ];
  const swift: Rule[] = [
    {
      re: rx(String.raw`\b(?<k>class|struct|enum|protocol|actor|extension|typealias)\s+${S}`),
      kind: (m) => ({ class: "class", struct: "class", actor: "class", enum: "enum", protocol: "interface", extension: "class", typealias: "type" })[m.groups!.k!] as DefinitionKind,
      strong: (m) => m.groups!.k !== "extension",
    },
    { re: rx(String.raw`\bfunc\s+${S}\s*[(<]`), kind: (_m, line) => (/^\s/.test(line) ? "method" : "function"), strong: true },
    { re: rx(String.raw`\b(?:let|var)\s+${S}`), kind: "variable", strong: true },
    { re: rx(String.raw`^\s*case\s+${S}\s*(?:\(|,|=|$)`), kind: "constant", strong: false },
  ];
  const python: Rule[] = [
    { re: rx(String.raw`^\s*(?:async\s+)?def\s+${S}\s*[(\[]`), kind: (_m, line) => (/^\s/.test(line) ? "method" : "function"), strong: true },
    { re: rx(String.raw`^\s*class\s+${S}`), kind: "class", strong: true },
    { re: rx(String.raw`^${S}\s*(?::[^=]+)?=(?!=)`), kind: "variable", strong: true },
    { re: rx(String.raw`^\s+self\.${S}\s*(?::[^=]+)?=(?!=)`), kind: "property", strong: false },
  ];
  const go: Rule[] = [
    { re: rx(String.raw`\bfunc\s+(?<recv>\([^)]*\)\s*)?${S}\s*[(\[]`), kind: (m) => (m.groups?.recv ? "method" : "function"), strong: true },
    {
      re: rx(String.raw`\btype\s+${S}(?:\s*\[[^\]]*\])?\s+(?<k>struct|interface)?`),
      kind: (m) => (m.groups?.k === "struct" ? "class" : m.groups?.k === "interface" ? "interface" : "type"), strong: true,
    },
    { re: rx(String.raw`^\s*(?:var|const)\s+${S}`), kind: "variable", strong: true },
    { re: rx(String.raw`^\s*${S}(?:\s*,\s*[\w$]+)*\s*:=`), kind: "variable", strong: false },
  ];
  const tld: Rule[] = [{ re: rx(String.raw`<name>\s*${S}\s*</name>`), kind: "tag", strong: true }];
  return { java, kotlin, js, vue: js, jsp: [...jspOwn, ...java, ...js], tld, swift, python, go, jspTags: jspOwn };
}

/** A line that is only a comment (per language) is never a definition. */
function isCommentLine(lang: Lang, line: string): boolean {
  const t = line.trimStart();
  if (lang === "python") return t.startsWith("#");
  if (lang === "jsp" && t.startsWith("<%--")) return true;
  if ((lang === "vue" || lang === "jsp" || lang === "tld") && t.startsWith("<!--")) return true;
  return t.startsWith("//") || t.startsWith("/*") || t.startsWith("* ") || t === "*";
}

type Classified = { kind: DefinitionKind; strong: boolean; column: number; name: string };

/** The first rule of the file's language that takes `text` for a definition of the word, with the word's 1-based column. */
export function classify(rules: Rule[], lang: Lang, text: string): Classified | null {
  if (text.length > LONG_LINE || isCommentLine(lang, text)) return null;
  // A JSP scriptlet / declaration opener reads as indentation (the same width, so columns stay the line's own).
  const line = lang === "jsp" ? text.replace(/<%(?![@-])[!=]?/g, (o) => " ".repeat(o.length)).replace(/%>/g, "  ") : text;
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    const m = rule.re.exec(line);
    if (!m) continue;
    if (rule.ok && !rule.ok(m, line)) continue;
    const at = m.indices?.groups?.s?.[0] ?? m.index;
    return {
      kind: typeof rule.kind === "function" ? rule.kind(m, line) : rule.kind,
      strong: typeof rule.strong === "function" ? rule.strong(m, line) : rule.strong,
      column: at + 1,
      name: m.groups?.s ?? "",
    };
  }
  return null;
}

// ---------------------------------------------------------------- git

const extOf = (p: string): string => {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};
export const langOf = (p: string): Lang | null => LANG_BY_EXT[extOf(p)] ?? null;
const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const withoutExt = (p: string): string => p.replace(/\.d\.ts$/, "").replace(/\.[^./]+$/, "");

type GrepLine = { path: string; line: number; text: string };
type GrepEnd = { stopped: "limit" | "timeout" | null };

/**
 * `git grep -n -z -I --untracked -w -F -e <word> [-- pathspecs]` over the worktree (tracked files and untracked ones git does
 * not ignore — §59's hidden repository too, through `shadowArgs`), read as it streams. `onLine` returns false to stop git.
 */
function grepWord(root: string, word: string, pathspecs: string[], timeoutMs: number, onLine: (l: GrepLine) => boolean): Promise<GrepEnd> {
  const threads = Math.max(1, Math.min(8, cpus().length));
  // The user's git config must not change the output or refuse the search (as `project_search`, §47).
  const args = ["-C", root, ...shadowArgs(root), "-c", "core.quotepath=off", "-c", "core.fsmonitor=", "-c", "submodule.recurse=false",
    "-c", "grep.column=false", "-c", "grep.fullName=false", "-c", "grep.fallbackToNoIndex=false",
    "grep", "-n", "-z", "-I", "--no-color", "--untracked", `--threads=${threads}`, "-w", "-F", "-e", word, "--", ...pathspecs];
  return new Promise<GrepEnd>((resolve, reject) => {
    let stopped: GrepEnd["stopped"] = null;
    let pending: Buffer = Buffer.alloc(0);
    let stderr = "";
    const child = spawn(getGitPath(), args, { cwd: root, env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stop = (why: "limit" | "timeout") => {
      if (stopped) return;
      stopped = why;
      child.kill("SIGTERM");
    };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      if (stopped) return;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let pos = 0;
      for (;;) {
        const pathEnd = pending.indexOf(0, pos);
        if (pathEnd < 0) break;
        const lineEnd = pending.indexOf(0, pathEnd + 1);
        if (lineEnd < 0) break;
        const textEnd = pending.indexOf(0x0a, lineEnd + 1);
        if (textEnd < 0) break;
        const keep = onLine({
          path: pending.toString("utf8", pos, pathEnd),
          line: Number.parseInt(pending.toString("latin1", pathEnd + 1, lineEnd), 10) || 0,
          text: pending.toString("utf8", lineEnd + 1, textEnd).replace(/\r$/, ""),
        });
        pos = textEnd + 1;
        if (!keep) {
          stop("limit");
          break;
        }
      }
      pending = pending.subarray(pos);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new CommandRefused(`search_failed:${e.message.slice(0, 200)}`, { code: "search_failed" }));
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      if (!stopped && status !== 0 && status !== 1) {
        const line = stderr.split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 200) ?? `exit ${status}`;
        reject(new CommandRefused(`search_failed:${line}`, { code: "search_failed" }));
        return;
      }
      resolve({ stopped });
    });
  });
}

/** Files (tracked + untracked, not ignored) matching any of `pathspecs` (git pathspec magic allowed). */
async function lsFiles(root: string, pathspecs: string[], timeoutMs: number): Promise<string[]> {
  if (pathspecs.length === 0) return [];
  const out = await runGit(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...pathspecs], { allowFailure: true, timeoutMs });
  if (out.status !== 0) return [];
  return [...new Set(out.text.split("\0").filter(Boolean))];
}

// ---------------------------------------------------------------- the clicked file's context

type Context = {
  path: string | null;
  lang: Lang | null;
  line: number | null;
  /** Repo-relative paths without extension the file imports the symbol from (or ends with, `endsWith`). */
  imported: { base: string; endsWith: boolean }[];
  /** Java / Kotlin package folders (`a/b/c`): the file's own package, wildcard imports. */
  packageDir: string | null;
  wildcardDirs: string[];
  /** JSP `<%@ taglib prefix tagdir %>`: prefix → folder (no leading slash). */
  tagDirs: Map<string, string>;
};

const PASCAL = (kebab: string): string => kebab.split("-").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");

/** What the clicked file says about where the symbol comes from — cheap: its first 2 MB, a few regexes. Never refuses. */
function readContext(root: string, fromPath: unknown, line: unknown, q: Query): Context {
  const ctx: Context = { path: null, lang: null, line: null, imported: [], packageDir: null, wildcardDirs: [], tagDirs: new Map() };
  const rel = typeof fromPath === "string" ? repoRelativeInside(root, fromPath) : null;
  if (rel === null) return ctx;
  ctx.path = rel;
  ctx.lang = langOf(rel);
  if (typeof line === "number" && Number.isFinite(line) && line >= 1) ctx.line = Math.floor(line);
  let lines: string[];
  try {
    const file = readProjectFile(root, rel);
    if (file.isBinary) return ctx;
    lines = file.lines;
  } catch {
    return ctx;
  }
  const ident = q.form === "fqn" ? q.word.slice(q.word.lastIndexOf(".") + 1) : q.form === "kebab" ? PASCAL(q.word) : q.form === "ident" ? q.word : null;
  const fromDir = dirOf(rel);
  const addJvmImport = (fqn: string, wildcard: boolean, alias?: string) => {
    const segs = fqn.split(".");
    if (wildcard) {
      ctx.wildcardDirs.push(segs.join("/"));
      return;
    }
    const last = segs[segs.length - 1];
    if (ident && (last === ident || alias === ident)) {
      ctx.imported.push({ base: segs.join("/"), endsWith: true });
      // `import static a.b.C.member` / an import of a nested class: the outer file too.
      if (segs.length > 1) ctx.imported.push({ base: segs.slice(0, -1).join("/"), endsWith: true });
    }
  };
  const addModule = (spec: string) => {
    if (spec.startsWith(".")) {
      const base = posix.normalize(posix.join(fromDir, spec));
      if (!base.startsWith("..")) ctx.imported.push({ base: withoutExt(base), endsWith: false });
    } else {
      const alias = /^(?:@@?|~)\/(.+)$/.exec(spec);
      if (alias) ctx.imported.push({ base: withoutExt(alias[1]!), endsWith: true });
      else if (spec.includes("/")) ctx.imported.push({ base: withoutExt(spec), endsWith: true });
    }
  };
  const wordRe = ident ? new RegExp(String.raw`(?<![\w$])${escapeRe(ident)}(?![\w$])`) : null;
  for (const raw of lines.slice(0, 3000)) {
    const l = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^package\s+([\w.]+)/.exec(l))) ctx.packageDir = m[1]!.split(".").join("/");
    else if ((m = /^import\s+(?:static\s+)?([\w$.]+?)(\.\*)?(?:\s+as\s+([\w$]+))?\s*;?$/.exec(l))) addJvmImport(m[1]!, !!m[2], m[3]);
    else if ((m = /^from\s+(\.*[\w.]*)\s+import\s+(.+)$/.exec(l)) && wordRe?.test(m[2]!)) {
      const mod = m[1]!;
      const dots = /^\.*/.exec(mod)![0].length;
      const rest = mod.slice(dots).split(".").filter(Boolean).join("/");
      if (dots > 0) {
        let dir = fromDir;
        for (let i = 1; i < dots; i++) dir = dirOf(dir);
        ctx.imported.push({ base: posix.join(dir, rest || ""), endsWith: false });
      } else ctx.imported.push({ base: rest, endsWith: true });
    }
    if (wordRe?.test(l)) {
      const es = /\bfrom\s*['"]([^'"]+)['"]/.exec(l) ?? /\brequire\(\s*['"]([^'"]+)['"]\s*\)/.exec(l) ?? /^import\s*\(?\s*['"]([^'"]+)['"]/.exec(l);
      if (es && /^(?:import|export|const|let|var)\b|\brequire\(/.test(l)) addModule(es[1]!);
    }
    for (const pm of l.matchAll(/<%@\s*page\b[^%]*?\bimport\s*=\s*"([^"]+)"/g)) {
      for (const one of pm[1]!.split(",")) {
        const t = one.trim();
        if (t) addJvmImport(t.replace(/\.\*$/, ""), t.endsWith(".*"));
      }
    }
    const tl = /<%@\s*taglib\b([^%]*)%>/.exec(l);
    if (tl) {
      const prefix = /\bprefix\s*=\s*"([^"]+)"/.exec(tl[1]!)?.[1];
      const dir = /\btagdir\s*=\s*"([^"]+)"/.exec(tl[1]!)?.[1];
      if (prefix && dir) ctx.tagDirs.set(prefix, dir.replace(/^\/+/, "").replace(/\/+$/, ""));
    }
  }
  return ctx;
}

// ---------------------------------------------------------------- ranking

export const VENDOR = /(?:^|\/)(?:node_modules|bower_components|vendor|third_party|dist|build|out|target|generated|\.gradle|Pods|DerivedData)\//;
export const MINIFIED = /\.min\.(?:js|css)$/;
export const TESTISH = /(?:^|\/)(?:test|tests|__tests__|spec|androidTest|testFixtures)\/|\.(?:test|spec)\.[^/]+$|(?:Test|Tests|Spec|IT)\.(?:java|kt|swift)$|_test\.go$|(?:^|\/)test_[^/]+\.py$/;
export const TYPE_KINDS = new Set<DefinitionKind>(["class", "interface", "enum", "record", "annotation", "object", "type", "module", "component", "tag", "file"]);

type Scored = DefinitionCandidate & { strong: boolean };

function score(c: Omit<Scored, "score">, ctx: Context, q: Query): number {
  let s = c.strong ? 100 : 40;
  const word = q.form === "fqn" ? q.word.slice(q.word.lastIndexOf(".") + 1) : q.word;
  // A capitalised name is usually a type, a lower-case one a function / variable.
  const upper = /^[A-Z]/.test(word) && !/^[A-Z][A-Z0-9_]+$/.test(word);
  if (upper === TYPE_KINDS.has(c.kind) || c.kind === "constructor") s += 10;
  const noExt = withoutExt(c.path);
  const dir = dirOf(c.path);
  let near = 0;
  if (ctx.path !== null) {
    if (c.path === ctx.path) near = 50;
    else if (dir === dirOf(ctx.path)) near = 25;
    if (ctx.packageDir && (dir === ctx.packageDir || dir.endsWith(`/${ctx.packageDir}`))) near = Math.max(near, 20);
    if (ctx.wildcardDirs.some((d) => dir === d || dir.endsWith(`/${d}`))) near = Math.max(near, 30);
    const imported = ctx.imported.some((i) => (i.endsWith
      ? noExt === i.base || noExt.endsWith(`/${i.base}`) || noExt === `${i.base}/index` || noExt.endsWith(`/${i.base}/index`)
      : noExt === i.base || noExt === `${i.base}/index` || noExt === `${i.base}/__init__`));
    if (imported) near = Math.max(near, 60);
    if (q.form === "tag" && ctx.tagDirs.has(q.prefix) && c.path.includes(`${ctx.tagDirs.get(q.prefix)!}/`)) near = Math.max(near, 60);
    if (c.path === ctx.path && ctx.line !== null && c.line <= ctx.line) s += 5;
    const fromLang = ctx.lang;
    const lang = langOf(c.path);
    if (fromLang && lang && FAMILY[fromLang].some((f) => FAMILY[lang].includes(f))) s += 15;
  }
  s += near;
  if (q.form === "fqn" && (noExt === q.fqnPath || noExt.endsWith(`/${q.fqnPath}`))) s += 80;
  if (VENDOR.test(c.path) || MINIFIED.test(c.path)) s -= 40;
  if (TESTISH.test(c.path) && !(ctx.path && TESTISH.test(ctx.path))) s -= 20;
  if (c.path.endsWith(".d.ts")) s -= 10;
  return s;
}

/** The line without its indent, at most `NAV_PREVIEW_MAX` characters around `column` ("…" where cut). */
export function navPreview(text: string, column: number): string {
  const indent = text.length - text.trimStart().length;
  const t = text.trim();
  if (t.length <= NAV_PREVIEW_MAX) return t;
  const at = Math.max(0, column - 1 - indent);
  const start = Math.max(0, Math.min(at - 60, t.length - NAV_PREVIEW_MAX));
  const end = start + NAV_PREVIEW_MAX;
  return (start > 0 ? "…" : "") + t.slice(start, end) + (end < t.length ? "…" : "");
}

// ---------------------------------------------------------------- find_definition

export type FindDefinitionOptions = { symbol: unknown; fromPath?: unknown; line?: unknown; timeoutMs?: number; scanMax?: number };
export type FindDefinitionResult = { symbol: string; candidates: DefinitionCandidate[]; truncated: boolean; timedOut?: true };

/**
 * `find_definition`: where `symbol` is declared. An identifier (or the last part of `a.b.C`) is searched as a word in the
 * files of known languages and each line is matched against its language's definition patterns; a component / tag / path
 * resolves to files by name. Ranked (see §62), deduplicated, at most `DEFINITION_MAX`.
 */
export async function findDefinition(root: string, opts: FindDefinitionOptions): Promise<FindDefinitionResult> {
  const q = parseSymbol(opts.symbol);
  const ctx = readContext(root, opts.fromPath, opts.line, q);
  const timeoutMs = opts.timeoutMs ?? DEFINITION_TIMEOUT_MS;
  const scanMax = opts.scanMax ?? DEFINITION_SCAN_MAX;
  const found = new Map<string, Omit<Scored, "score">>();
  const add = (c: Omit<Scored, "score">) => {
    const key = `${c.path}\0${c.line}`;
    const had = found.get(key);
    if (!had || (c.strong && !had.strong)) found.set(key, c);
  };

  // Files by name: Vue components (MyWidget ↔ MyWidget.vue / my-widget.vue / my-widget/index.vue), JSP tag files, paths.
  const filePatterns: { spec: string; kind: DefinitionKind }[] = [];
  const word = q.form === "fqn" ? q.word.slice(q.word.lastIndexOf(".") + 1) : q.form === "tag" ? q.name : q.word;
  if ((q.form === "ident" && /^[A-Z]/.test(word)) || q.form === "kebab") {
    const kebab = q.form === "kebab" ? word.toLowerCase() : word.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    const pascal = q.form === "kebab" ? PASCAL(word) : word;
    for (const name of new Set([pascal, kebab])) {
      filePatterns.push({ spec: `:(glob,icase)**/${name}.vue`, kind: "component" }, { spec: `:(glob,icase)**/${name}/index.vue`, kind: "component" });
    }
  }
  if (q.form === "tag" || q.form === "kebab" || (q.form === "ident" && ctx.lang === "jsp")) {
    for (const ext of ["tag", "tagx"]) filePatterns.push({ spec: `:(glob)**/${word}.${ext}`, kind: "tag" });
  }
  let exactRelative: string | null = null;
  if (q.form === "path") {
    const stripped = q.path.replace(/^(?:\.{1,2}\/)+/, "").replace(/^\/+/, "");
    if (!q.path.startsWith("/") && ctx.path !== null) {
      const joined = posix.normalize(posix.join(dirOf(ctx.path), q.path));
      if (!joined.startsWith("..") && !joined.startsWith("/")) exactRelative = joined;
    }
    if (exactRelative) filePatterns.push({ spec: `:(literal)${exactRelative}`, kind: "file" });
    if (stripped) filePatterns.push({ spec: `:(glob)**/${stripped}`, kind: "file" });
  }
  // A path that resolves exactly (relative to the clicked file) or an absolute one (`/WEB-INF/…`, the web root's) found by its
  // ending is a sure hit; a relative one found only by its ending is a loose one.
  const sureFile = (path: string): boolean => q.form !== "path" || path === exactRelative || q.path.startsWith("/");
  const byName = Promise.all(filePatterns.map(async ({ spec, kind }) => {
    for (const path of await lsFiles(root, [spec], timeoutMs)) {
      add({ path, line: 1, column: 1, kind, preview: path.slice(path.lastIndexOf("/") + 1), strong: kind !== "file" || sureFile(path) });
    }
  }));

  // The word, through the definition patterns of each file's language.
  let truncated = false;
  let timedOut = false;
  const grepped = (async () => {
    if (q.form === "path" || q.form === "kebab") return;
    const rules = rulesFor(word);
    let scanned = 0;
    const end = await grepWord(root, word, q.form === "tag" ? ["*.tld"] : DEFINITION_PATHSPECS, timeoutMs, (l) => {
      scanned += 1;
      const lang = langOf(l.path);
      const hit = lang ? classify(rules[lang], lang, l.text) : null;
      if (hit) add({ path: l.path, line: l.line, column: hit.column, kind: hit.kind, preview: navPreview(l.text, hit.column), strong: hit.strong });
      return scanned < scanMax;
    });
    if (end.stopped === "limit") truncated = true;
    if (end.stopped === "timeout") timedOut = true;
  })();
  await Promise.all([byName, grepped]);

  const ranked = [...found.values()]
    .map((c) => ({ ...c, score: score(c, ctx, q) }))
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line);
  if (ranked.length > DEFINITION_MAX) truncated = true;
  const candidates = ranked.slice(0, DEFINITION_MAX).map(({ strong: _strong, ...c }) => c);
  return { symbol: q.word, candidates, truncated, ...(timedOut ? { timedOut: true as const } : {}) };
}

// ---------------------------------------------------------------- find_references

export type FindReferencesOptions = { symbol: unknown; fromPath?: unknown; limit?: unknown; timeoutMs?: number };
export type FindReferencesResult = { symbol: string; hits: ReferenceHit[]; files: number; truncated: boolean; timedOut?: true };

/**
 * `find_references`: every line holding `symbol` as a whole word (`git grep -w -F`), case-sensitive — the clicked file
 * first, then its folder, then the rest by path; line order within a file. A line that is a definition by §62's patterns
 * carries its `kind`. At most `limit` (default 500, ≤ 2 000), then `truncated`.
 */
export async function findReferences(root: string, opts: FindReferencesOptions): Promise<FindReferencesResult> {
  const q = parseSymbol(opts.symbol);
  const limit = typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit >= 1
    ? Math.min(REFERENCES_MAX_LIMIT, Math.floor(opts.limit)) : REFERENCES_DEFAULT_LIMIT;
  const from = typeof opts.fromPath === "string" ? repoRelativeInside(root, opts.fromPath) : null;
  const wordRe = new RegExp(String.raw`(?<![\w$])${escapeRe(q.word)}(?![\w$])`);
  const rules = q.form === "ident" ? rulesFor(q.word) : null;
  const hits: ReferenceHit[] = [];
  let truncated = false;
  const end = await grepWord(root, q.word, [], opts.timeoutMs ?? REFERENCES_TIMEOUT_MS, (l) => {
    if (hits.length >= limit) {
      truncated = true;
      return false;
    }
    const at = wordRe.exec(l.text)?.index ?? l.text.indexOf(q.word);
    const column = Math.max(0, at) + 1;
    const lang = langOf(l.path);
    const def = rules && lang ? classify(rules[lang], lang, l.text) : null;
    hits.push({ path: l.path, line: l.line, column, preview: navPreview(l.text, column), ...(def ? { kind: def.kind } : {}) });
    return true;
  });
  const fromDir = from === null ? null : dirOf(from);
  const rank = (p: string): number => (p === from ? 0 : fromDir !== null && dirOf(p) === fromDir ? 1 : 2);
  hits.sort((a, b) => rank(a.path) - rank(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line);
  return {
    symbol: q.word,
    hits,
    files: new Set(hits.map((h) => h.path)).size,
    truncated,
    ...(end.stopped === "timeout" ? { timedOut: true as const } : {}),
  };
}
