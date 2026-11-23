// MARK: ide-nav — docs/PROTOCOL.md §65: the declarations of one file with their containers (the enclosing class / object /
// interface / component), read with §62's per-language patterns (`rulesFor(null)`: any identifier) and a brace / indentation
// tracker. No parser: comments and strings are blanked, braces counted, and only lines directly in a type's body (or at the
// top level) are read as declarations — a local inside a method body never is one.
import { CommandRefused } from "../errors.js";
import type { DefinitionKind, NavSymbol, SymbolPreviewEvent } from "../protocol.js";
import { readProjectFile } from "./browse.js";
import { classify, langOf, rulesFor, TYPE_KINDS, type Lang } from "./navigate.js";

/** One file never yields more symbols than this (a generated file). */
export const FILE_SYMBOLS_MAX = 5_000;
/** `signature`: the declaration's line, trimmed, at most this many characters. */
export const SIGNATURE_MAX = 200;
/** `definition_preview` sends at most this many lines. */
export const PREVIEW_MAX_LINES = 80;
/** …by default this many after the line (before it: the comment / annotation block above the declaration). */
export const PREVIEW_DEFAULT_AFTER = 15;
const PREVIEW_DEFAULT_BEFORE_MAX = 20;
const LONG_LINE = 2_000;

/** A symbol of one file: `NavSymbol` without its path, plus how many containers of the file enclose it. */
export type FileSymbol = Omit<NavSymbol, "path"> & { depth: number };

let RULES: ReturnType<typeof rulesFor> | null = null;
const rules = (): ReturnType<typeof rulesFor> => (RULES ??= rulesFor(null));

/** The language of a path the index reads (§62's extensions), else null. */
export const symbolLang = (path: string): Lang | null => langOf(path);

// ---------------------------------------------------------------- blanking comments and strings

/**
 * The file's lines with comments and the contents of strings replaced by spaces (same lengths, so columns hold), the quotes
 * kept. Backtick strings span lines in JS / Go, `"""` in Kotlin / Swift / Java / Python; Python's comments are `#`.
 */
export function maskLines(text: string, lang: Lang): string[] {
  const py = lang === "python";
  const multiBacktick = lang === "js" || lang === "vue" || lang === "jsp" || lang === "go";
  const out: string[] = [];
  let line = "";
  // 0 code, 1 line comment, 2 block comment, 3 quoted string, 4 backtick, 5 triple-quoted
  let st = 0;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\n") {
      out.push(line);
      line = "";
      if (st === 1 || st === 3 || (st === 4 && !multiBacktick)) st = 0;
      continue;
    }
    if (st === 0) {
      if (!py && ch === "/" && text[i + 1] === "/") {
        st = 1;
        line += " ";
      } else if (!py && ch === "/" && text[i + 1] === "*") {
        st = 2;
        line += "  ";
        i++;
      } else if (py && ch === "#") {
        st = 1;
        line += " ";
      } else if ((ch === '"' || (py && ch === "'")) && text[i + 1] === ch && text[i + 2] === ch) {
        st = 5;
        quote = ch;
        line += ch + ch + ch;
        i += 2;
      } else if (ch === '"' || ch === "'") {
        st = 3;
        quote = ch;
        line += ch;
      } else if (ch === "`") {
        st = 4;
        line += ch;
      } else line += ch;
    } else if (st === 1) line += " ";
    else if (st === 2) {
      if (ch === "*" && text[i + 1] === "/") {
        st = 0;
        line += "  ";
        i++;
      } else line += " ";
    } else if (st === 3 || st === 4) {
      if (ch === "\\" && i + 1 < text.length && text[i + 1] !== "\n") {
        line += "  ";
        i++;
      } else if ((st === 3 && ch === quote) || (st === 4 && ch === "`")) {
        st = 0;
        line += ch;
      } else line += " ";
    } else {
      if (ch === quote && text[i + 1] === quote && text[i + 2] === quote) {
        st = 0;
        line += quote + quote + quote;
        i += 2;
      } else line += " ";
    }
  }
  out.push(line);
  return out;
}

// ---------------------------------------------------------------- brace languages

type Role = "type" | "object" | "component" | "group";
type Container = {
  qname: string;
  simple: string;
  kind: DefinitionKind;
  role: Role;
  bodyDepth: number;
  /** Index of its symbol in the output, -1 for one without (an object group, `export default {`). */
  sym: number;
  /** Java / Kotlin / TS enum: entries come until the first `;` of the body. */
  enumOpen: boolean;
  /** Vue options group: the kind its members get (`computed` → property). */
  groupKind?: DefinitionKind;
};
type Pending = { c: Omit<Container, "bodyDepth">; depth: number; parens: number; maxParens: number; line: number; fromCol: number };

const JS_RESERVED = new Set(["if", "for", "while", "switch", "catch", "return", "function", "with", "else", "do", "try", "finally", "new", "typeof",
  "delete", "void", "await", "yield", "case", "default", "throw", "import", "export", "super", "this", "in", "of", "instanceof", "var", "let", "const"]);
const CONTAINER_KINDS = new Set<DefinitionKind>(["class", "interface", "enum", "record", "annotation", "object", "module"]);
const IDENT = String.raw`[A-Za-z_$][\w$]*`;
const TSMODS = String.raw`(?:(?:static|async|get|set|public|private|protected|readonly|override|abstract|declare|accessor)\s+)*`;
const rxd = (src: string): RegExp => new RegExp(src, "d");
const ENUM_ENTRY = rxd(String.raw`^\s*(?:@[\w$.]+(?:\([^)]*\))?\s+)*(${IDENT})\s*(?:\(.*\))?\s*(?:=[^,;{]*)?\s*[,;{]?\s*(?:\/\/.*)?$`);
const JS_MEMBER_METHOD = rxd(String.raw`^\s*${TSMODS}\*?\s*#?(${IDENT})\s*[?!]?\s*(?:<[^>]*>)?\s*\(`);
const JS_CLASS_FIELD = rxd(String.raw`^\s*${TSMODS}#?(${IDENT})\s*[?!]?\s*(?::[^=;]+)?(?:=(?!=)|;|$)`);
const JS_KEY = rxd(String.raw`^\s*(?:readonly\s+)?(${IDENT})\s*\??\s*:(?!:)`);
const JS_ARROW_VALUE = /^\s*(?:async\s+)?(?:function\b|(?:\([^)]*\)|[\w$]+)\s*=>)/;
const JS_OBJECT_VALUE = /^\s*(?::[^=]+)?=\s*(?:Object\.freeze\s*\(\s*|[\w$.]+\s*\(\s*)?\{/;
const JS_DEFAULT_OBJECT = /^\s*(?:export\s+default|module\.exports\s*=)\s*(?:[\w$.]+\s*\(\s*)?\{/;
const JS_TOPLEVEL = /^(?:export|function|class|const|let|var|interface|type|enum|async|abstract|declare|namespace)\b/;
const VUE_GROUP = /^\s*(methods|computed|watch|props|filters)\s*:\s*\{/;
const KT_COMPANION = rxd(String.raw`^\s*(?:(?:private|internal|public|protected)\s+)?companion\s+object\b(?:\s+(${IDENT}))?`);
const KT_CONSTRUCTOR = rxd(String.raw`^\s*(?:(?:private|internal|public|protected)\s+|@[\w$.]+(?:\([^)]*\))?\s+)*(constructor)\s*\(`);
const KT_CTOR_PROP = /(?:^|[(,\s])(?:(?:private|internal|public|protected|override|open|final|lateinit)\s+|@[\w$.]+(?:\([^)]*\))?\s+)*(?:val|var)\s+([A-Za-z_$][\w$]*)/dg;
const SWIFT_INIT = rxd(String.raw`^\s*(?:(?:public|private|internal|fileprivate|open|convenience|required|override|@[\w$]+)\s+)*(init)[?!]?\s*[(<]`);
const GO_RECEIVER = /\bfunc\s*\(\s*(?:[\w$]+\s+)?\*?\s*([\w$]+)/;
const GO_FIELD = rxd(String.raw`^\s*([A-Za-z_]\w*)(?:\s*,\s*[A-Za-z_]\w*)*\s+[^\s=/]`);
const GO_IFACE_METHOD = rxd(String.raw`^\s*([A-Za-z_]\w*)\s*\(`);
const GO_TOPLEVEL = /^(?:func|type|var|const|import|package)\b/;

type Found = { name: string; kind: DefinitionKind; column: number; container?: string; nested?: true; opens?: { role: Role; kind: DefinitionKind; maxParens?: number; groupKind?: DefinitionKind; enumOpen?: boolean; simple?: string; noSymbol?: boolean } };

type Options = {
  /** Every top-level symbol is a member of this container (a Vue `<script setup>`'s component). */
  base?: string;
  /** Java: the top level is a class body (a JSP's `<%! %>` declarations). */
  topAsBody?: boolean;
  /** `export default {` / `module.exports = {` opens a container of this name (a Vue component; the file's stem otherwise). */
  defaultObject?: { name: string; role: Role };
};

const signatureOf = (raw: string): string => {
  const t = raw.trim().replace(/\s*\{\s*$/, "");
  return t.length > SIGNATURE_MAX ? t.slice(0, SIGNATURE_MAX) : t;
};
const groupAt = (m: RegExpExecArray, g: number): number => (m.indices?.[g]?.[0] ?? m.index) + 1;

/** Declarations of a brace language in `text` (Java, Kotlin, JS / TS, Swift, Go), file order. */
function braceSymbols(text: string, lang: "java" | "kotlin" | "js" | "swift" | "go", opts: Options = {}): FileSymbol[] {
  const R = rules();
  const lines = text.split("\n");
  const masked = maskLines(text, lang);
  const out: FileSymbol[] = [];
  const stack: Container[] = [];
  let depth = 0;
  let pending: Pending | null = null;
  const baseDepth = opts.base ? 1 : 0;

  const qualified = (): string | undefined => (stack.length ? stack[stack.length - 1]!.qname : opts.base);
  const depthOf = (): number => baseDepth + stack.filter((c) => c.sym >= 0).length;
  const close = (ln: number) => {
    depth = Math.max(0, depth - 1);
    while (stack.length && stack[stack.length - 1]!.bodyDepth > depth) {
      const c = stack.pop()!;
      if (c.sym >= 0) out[c.sym]!.endLine = ln;
    }
    if (pending && depth < pending.depth) pending = null;
  };

  for (let i = 0; i < lines.length && out.length < FILE_SYMBOLS_MAX; i++) {
    const ln = i + 1;
    const raw = lines[i]!;
    const code = masked[i] ?? "";
    if (raw.length > LONG_LINE) {
      for (const ch of code) if (ch === "{") depth++;
      else if (ch === "}") close(ln);
      continue;
    }
    // Closing braces at the start of the line end their blocks before the line is read.
    let k = 0;
    while (k < code.length && (code[k] === " " || code[k] === "\t" || code[k] === "}")) {
      if (code[k] === "}") close(ln);
      k++;
    }
    const startsInCode = k < code.length && code[k] === raw[k];
    // A top-level declaration at column 0 of JS / Go resynchronises the tracker (a regex literal may have thrown it off).
    if (k === 0 && startsInCode && ((lang === "js" && JS_TOPLEVEL.test(raw)) || (lang === "go" && GO_TOPLEVEL.test(raw))) && (depth > 0 || stack.length)) {
      while (stack.length) {
        const c = stack.pop()!;
        if (c.sym >= 0) out[c.sym]!.endLine = Math.max(out[c.sym]!.line, ln - 1);
      }
      depth = 0;
      pending = null;
    }
    const top = stack.length ? stack[stack.length - 1]! : null;
    const direct = top ? depth === top.bodyDepth : depth === 0;
    let found: Found | null = null;
    if (startsInCode && code.trim() !== "") {
      if (lang === "kotlin" && pending && pending.parens > 0 && depth === pending.depth) {
        // A primary constructor's `val` / `var` parameters, one line each.
        for (const m of raw.matchAll(KT_CTOR_PROP)) {
          const col = groupAt(m, 1);
          if (code[col - 1] !== raw[col - 1]) continue;
          out.push({ name: m[1]!, kind: "property", line: ln, column: col, container: pending.c.qname, signature: signatureOf(raw), depth: depthOf() + 1 });
        }
      } else if (direct) found = declare(lang, raw, code, top, opts, R);
      else if (lang === "js" && /\bfunction\b/.test(code)) {
        const c = classify(R.js.slice(0, 1), "js", raw);
        // A named function inside a function body (a jQuery `$(function () { … })` page script): no container.
        if (c && code[c.column - 1] === raw[c.column - 1] && !JS_RESERVED.has(c.name)) found = { name: c.name, kind: "function", column: c.column, nested: true };
      }
    }
    if (found) {
      if (pending) pending = null;
      const container = found.nested ? undefined : found.container ?? (found.opens?.role === "group" ? undefined : qualified());
      let sym = -1;
      if (!found.opens?.noSymbol) {
        sym = out.length;
        // A function in a type's / object's body is a method (an extension function keeps `function`).
        const kind = found.kind === "function" && stack.length > 0 && !found.container && !found.nested ? "method" : found.kind;
        out.push({ name: found.name, kind, line: ln, column: found.column, ...(container ? { container } : {}), signature: signatureOf(raw), depth: depthOf() });
        // Kotlin `class A(val x: Int, …)`: the primary constructor's properties on the declaration's line.
        if (lang === "kotlin" && found.opens?.role === "type") {
          const qname = container ? `${container}.${found.name}` : found.name;
          for (const m of raw.matchAll(KT_CTOR_PROP)) {
            const col = groupAt(m, 1);
            if (col <= found.column || code[col - 1] !== raw[col - 1]) continue;
            out.push({ name: m[1]!, kind: "property", line: ln, column: col, container: qname, signature: signatureOf(raw), depth: depthOf() + 1 });
          }
        }
      }
      if (found.opens) {
        const o = found.opens;
        const qname = o.role === "group" ? (top?.qname ?? found.name) : container && o.role !== "component" ? `${container}.${found.name}` : found.name;
        pending = {
          c: { qname, simple: o.simple ?? found.name, kind: o.kind, role: o.role, sym, enumOpen: o.enumOpen === true, ...(o.groupKind ? { groupKind: o.groupKind } : {}) },
          depth, parens: 0, maxParens: o.maxParens ?? 0, line: ln, fromCol: found.column - 1,
        };
      }
    }
    for (let j = k; j < code.length; j++) {
      const ch = code[j];
      if (ch === "{") {
        depth++;
        if (pending && depth - 1 === pending.depth && pending.parens <= pending.maxParens && (pending.line < ln || j >= pending.fromCol)) {
          stack.push({ ...pending.c, bodyDepth: depth });
          pending = null;
        }
      } else if (ch === "}") close(ln);
      else if (ch === "(" && pending) pending.parens++;
      else if (ch === ")" && pending) pending.parens--;
      else if (ch === ";") {
        if (pending && pending.parens <= 0 && depth === pending.depth) pending = null;
        const t = stack[stack.length - 1];
        if (t && t.enumOpen && depth === t.bodyDepth) t.enumOpen = false;
      }
    }
  }
  for (const c of stack) if (c.sym >= 0 && out[c.sym]!.endLine === undefined) out[c.sym]!.endLine = lines.length;
  return out;
}

/** The declaration a line directly in `top`'s body (or at the top level) makes, by language. */
function declare(lang: "java" | "kotlin" | "js" | "swift" | "go", raw: string, code: string, top: Container | null, opts: Options, R: ReturnType<typeof rulesFor>): Found | null {
  const isCode = (col: number): boolean => code[col - 1] === raw[col - 1];
  const opensType = (kind: DefinitionKind, enumOpen = false): Found["opens"] => ({ role: "type", kind, enumOpen });
  const inEnum = top?.kind === "enum" && top.enumOpen;
  if (inEnum && (lang === "java" || lang === "kotlin" || lang === "js")) {
    const m = ENUM_ENTRY.exec(raw);
    if (m && isCode(groupAt(m, 1)) && !JS_RESERVED.has(m[1]!)) return { name: m[1]!, kind: "constant", column: groupAt(m, 1) };
  }

  if (lang === "java") {
    if (top && top.role === "type") {
      // `Name(…) { … }` on one line: §62's constructor rule wants no `;` after the parenthesis.
      const m = new RegExp(String.raw`^\s*(?:(?:public|protected|private)\s+|@[\w$.]+(?:\([^)]*\))?\s+)*(${top.simple.replace(/\$/g, "\\$")})\s*\(`, "d").exec(raw);
      if (m && isCode(groupAt(m, 1))) return { name: top.simple, kind: "constructor", column: groupAt(m, 1) };
    }
    const c = classify(R.java, "java", raw);
    if (!c || !isCode(c.column)) return null;
    if (CONTAINER_KINDS.has(c.kind)) return { name: c.name, kind: c.kind, column: c.column, opens: opensType(c.kind, c.kind === "enum") };
    if (!top && !opts.topAsBody) return null;
    if (c.kind === "constructor" && top && c.name !== top.simple) return null;
    if (c.kind === "constant" && top?.kind !== "enum") return null;
    return { name: c.name, kind: c.kind, column: c.column };
  }

  if (lang === "kotlin") {
    if (top && top.role === "type") {
      let m = KT_COMPANION.exec(raw);
      if (m) {
        const name = m[1] ?? "Companion";
        return { name, kind: "object", column: m[1] ? groupAt(m, 1) : raw.indexOf("companion") + 1, opens: opensType("object") };
      }
      m = KT_CONSTRUCTOR.exec(raw);
      if (m && isCode(groupAt(m, 1))) return { name: top.simple, kind: "constructor", column: groupAt(m, 1) };
    }
    const c = classify(R.kotlin, "kotlin", raw);
    if (!c || !isCode(c.column)) return null;
    if (CONTAINER_KINDS.has(c.kind)) return { name: c.name, kind: c.kind, column: c.column, opens: opensType(c.kind, c.kind === "enum") };
    if (c.kind === "constant" && top?.kind !== "enum") return null;
    if (c.kind === "function") {
      // An extension function `fun Type.name(` / `fun <T> List<T>.name(`: a member of its receiver type (at the top level).
      const rm = new RegExp(String.raw`\bfun\s+(?:<[^>]*>\s*)?([\w$.]+?)(?:<[^>]*>)?\??\.${c.name.replace(/\$/g, "\\$")}\s*[(<]`).exec(raw);
      if (rm && !top) {
        const recv = rm[1]!.split(".").pop()!;
        return { name: c.name, kind: "function", column: c.column, container: recv };
      }
    }
    return { name: c.name, kind: c.kind, column: c.column };
  }

  if (lang === "swift") {
    if (top && top.role === "type") {
      const m = SWIFT_INIT.exec(raw);
      if (m) return { name: top.simple, kind: "constructor", column: groupAt(m, 1) };
    }
    // `class func` / `static var`: a member, not a type named `func`.
    const sraw = raw.replace(/\b(?:class|static)\s+(?=(?:func|var|let|subscript)\b)/, (x) => " ".repeat(x.length));
    const c = classify(R.swift, "swift", sraw);
    if (!c || !isCode(c.column)) return null;
    if (/\b(?:class|struct|enum|protocol|actor|extension)\s/.test(sraw.slice(0, c.column - 1)) && c.kind !== "type") {
      return { name: c.name, kind: c.kind, column: c.column, opens: opensType(c.kind) };
    }
    if (c.kind === "constant" && top?.kind !== "enum") return null;
    return { name: c.name, kind: c.kind, column: c.column };
  }

  if (lang === "go") {
    if (top) {
      const m = (top.kind === "interface" ? GO_IFACE_METHOD : GO_FIELD).exec(raw);
      if (!m || !isCode(groupAt(m, 1))) return null;
      return { name: m[1]!, kind: top.kind === "interface" ? "method" : "field", column: groupAt(m, 1) };
    }
    const c = classify(R.go.slice(0, 3), "go", raw);
    if (!c || !isCode(c.column)) return null;
    if (c.kind === "class" || c.kind === "interface") return { name: c.name, kind: c.kind, column: c.column, opens: opensType(c.kind) };
    if (c.kind === "method") {
      const recv = GO_RECEIVER.exec(raw)?.[1];
      return { name: c.name, kind: "method", column: c.column, ...(recv ? { container: recv } : {}) };
    }
    return { name: c.name, kind: c.kind, column: c.column };
  }

  // JS / TS (also a Vue SFC's and a JSP's scripts).
  const role = top?.role ?? null;
  if (!top && JS_DEFAULT_OBJECT.test(code) && opts.defaultObject) {
    const d = opts.defaultObject;
    return { name: d.name, kind: d.role === "component" ? "component" : "variable", column: 1, opens: { role: d.role, kind: "object", maxParens: 1, simple: d.name, noSymbol: true } };
  }
  if (role === "component") {
    const g = VUE_GROUP.exec(code);
    if (g) {
      const which = g[1]!;
      const groupKind: DefinitionKind = which === "computed" || which === "props" ? "property" : "method";
      return { name: top!.qname, kind: groupKind, column: 1, opens: { role: "group", kind: "object", groupKind, noSymbol: true } };
    }
  }
  const c = classify(R.js, "js", raw);
  if (c && isCode(c.column) && !JS_RESERVED.has(c.name)) {
    if (c.kind === "class" || c.kind === "interface" || c.kind === "enum" || c.kind === "module") {
      return { name: c.name, kind: c.kind, column: c.column, opens: opensType(c.kind, c.kind === "enum") };
    }
    if (c.kind === "type") {
      const after = code.slice(c.column - 1 + c.name.length);
      return { name: c.name, kind: "type", column: c.column, ...(/^\s*(?:<[^>]*>)?\s*=\s*\{/.test(after) ? { opens: opensType("type") } : {}) };
    }
    if (!top) {
      if (c.kind === "method" || c.kind === "property" || c.kind === "component") return null;
      if (c.kind === "variable" && JS_OBJECT_VALUE.test(code.slice(c.column - 1 + c.name.length))) {
        return { name: c.name, kind: "variable", column: c.column, opens: { role: "object", kind: "variable", maxParens: 1 } };
      }
      return { name: c.name, kind: c.kind, column: c.column };
    }
    if (role === "component" && (c.kind === "property" || c.kind === "component")) return null;
    if (c.kind === "variable" && role !== null && top.kind !== "module") return null; // a `const` can only be a local here
    const kind = top.groupKind ?? (c.kind === "function" ? "method" : c.kind);
    if (role === "type" && top.kind === "class" && c.name === "constructor") return { name: c.name, kind: "constructor", column: c.column };
    return { name: c.name, kind, column: c.column };
  }
  if (!top || top.kind === "module") return null;
  // What §62's patterns leave to the context: a member shorthand spread over lines, a class field without a modifier,
  // an interface member, an object key.
  let m = JS_MEMBER_METHOD.exec(raw);
  if (m && isCode(groupAt(m, 1)) && !JS_RESERVED.has(m[1]!)) {
    const name = m[1]!;
    const kind: DefinitionKind = top.kind === "class" && name === "constructor" ? "constructor" : top.groupKind ?? "method";
    return { name, kind, column: groupAt(m, 1) };
  }
  if (role === "type" && top.kind === "class") {
    m = JS_CLASS_FIELD.exec(raw);
    if (m && isCode(groupAt(m, 1)) && !JS_RESERVED.has(m[1]!)) {
      const rest = raw.slice(m.indices![1]![1]).replace(/^\s*[?!]?\s*(?::[^=;]+)?=/, "");
      return { name: m[1]!, kind: JS_ARROW_VALUE.test(rest) ? "method" : "property", column: groupAt(m, 1) };
    }
  }
  if (role === "component") return null;
  m = JS_KEY.exec(raw);
  if (m && isCode(groupAt(m, 1)) && !JS_RESERVED.has(m[1]!)) {
    const rest = raw.slice(m.indices![0]![1]);
    return { name: m[1]!, kind: top.groupKind ?? (JS_ARROW_VALUE.test(rest) ? "method" : "property"), column: groupAt(m, 1) };
  }
  return null;
}

// ---------------------------------------------------------------- Python (indentation)

const PY_CLASS = rxd(String.raw`^(\s*)class\s+(${IDENT})`);
const PY_DEF = rxd(String.raw`^(\s*)(?:async\s+)?def\s+(${IDENT})\s*[(\[]`);
const PY_VAR = rxd(String.raw`^(${IDENT})\s*(?::[^=]+)?=(?!=)`);

function pythonSymbols(text: string): FileSymbol[] {
  const lines = text.split("\n");
  const masked = maskLines(text, "python");
  const out: FileSymbol[] = [];
  const stack: { indent: number; qname: string; isClass: boolean; sym: number }[] = [];
  let lastCode = 0;
  for (let i = 0; i < lines.length && out.length < FILE_SYMBOLS_MAX; i++) {
    const raw = lines[i]!;
    const code = masked[i] ?? "";
    if (code.trim() === "" || raw.length > LONG_LINE) continue;
    const indent = raw.length - raw.trimStart().length;
    if (code[indent] !== raw[indent]) continue; // inside a docstring
    while (stack.length && indent <= stack[stack.length - 1]!.indent) {
      const s = stack.pop()!;
      out[s.sym]!.endLine = lastCode;
    }
    lastCode = i + 1;
    const top = stack[stack.length - 1];
    let m = PY_CLASS.exec(raw);
    if (m && (!top || top.isClass)) {
      out.push({ name: m[2]!, kind: "class", line: i + 1, column: groupAt(m, 2), ...(top ? { container: top.qname } : {}), signature: signatureOf(raw), depth: stack.length });
      stack.push({ indent, qname: top ? `${top.qname}.${m[2]!}` : m[2]!, isClass: true, sym: out.length - 1 });
      continue;
    }
    m = PY_DEF.exec(raw);
    if (m && (!top || top.isClass)) {
      out.push({ name: m[2]!, kind: top ? "method" : "function", line: i + 1, column: groupAt(m, 2), ...(top ? { container: top.qname } : {}), signature: signatureOf(raw), depth: stack.length });
      stack.push({ indent, qname: m[2]!, isClass: false, sym: out.length - 1 });
      continue;
    }
    m = PY_VAR.exec(raw);
    if (m && !top) out.push({ name: m[1]!, kind: "variable", line: i + 1, column: 1, signature: signatureOf(raw), depth: 0 });
  }
  for (const s of stack) out[s.sym]!.endLine = lastCode;
  return out;
}

// ---------------------------------------------------------------- Vue and JSP: their regions

/** `text` with everything outside [start, end) ranges blanked (newlines kept, so lines and columns hold). */
function keepOnly(text: string, ranges: [number, number][]): string {
  let out = "";
  let at = 0;
  for (const [s, e] of ranges) {
    out += text.slice(at, s).replace(/[^\n]/g, " ") + text.slice(s, e);
    at = e;
  }
  return out + text.slice(at).replace(/[^\n]/g, " ");
}

const PASCAL = (stem: string): string => stem.split(/[-_.\s]+/).filter(Boolean).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
const stemOf = (path: string): string => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.indexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  // `index.vue` names its folder's component.
  if (stem === "index" && path.includes("/")) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    return dir.slice(dir.lastIndexOf("/") + 1);
  }
  return stem;
};
const lineAt = (text: string, offset: number): number => {
  let n = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};

function vueSymbols(path: string, text: string): FileSymbol[] {
  const comp = PASCAL(stemOf(path)) || "Component";
  const total = text.split("\n").length;
  const first = /<(?:template|script)\b/.exec(text);
  const head: FileSymbol = { name: comp, kind: "component", line: first ? lineAt(text, first.index) : 1, column: 1, depth: 0, endLine: total };
  const out: FileSymbol[] = [head];
  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/g)) {
    if (/\bsrc\s*=/.test(m[1]!)) continue;
    const start = m.index! + m[0].indexOf(">") + 1;
    const only = keepOnly(text, [[start, start + m[2]!.length]]);
    const setup = /\bsetup\b/.test(m[1]!);
    // Every symbol of a script is inside the SFC's component (`<script setup>`'s top level: its members).
    const found = braceSymbols(only, "js", setup ? { base: comp } : { defaultObject: { name: comp, role: "component" } });
    for (const s of found) out.push(setup ? s : { ...s, depth: s.depth + 1 });
  }
  return out.sort((a, b) => a.line - b.line || a.column - b.column);
}

function jspSymbols(text: string): FileSymbol[] {
  const R = rules();
  const decl: [number, number][] = [];
  const script: [number, number][] = [];
  for (const m of text.matchAll(/<%!([\s\S]*?)%>/g)) decl.push([m.index! + 3, m.index! + 3 + m[1]!.length]);
  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/.test(m[1]!)) continue;
    const start = m.index! + m[0].indexOf(">") + 1;
    script.push([start, start + m[2]!.length]);
  }
  const out: FileSymbol[] = [];
  if (decl.length) out.push(...braceSymbols(keepOnly(text, decl), "java", { topAsBody: true }));
  if (script.length) {
    // JSP inside a script (`<%= x %>`, `${x}`) reads as blanks.
    const js = keepOnly(text, script).replace(/<%[\s\S]*?%>/g, (s) => s.replace(/[^\n]/g, " ")).replace(/\$\{[^}\n]*\}/g, (s) => " ".repeat(s.length));
    out.push(...braceSymbols(js, "js"));
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.includes("<") || raw.length > LONG_LINE) continue;
    const c = classify(R.jspTags, "jsp", raw);
    if (c) out.push({ name: c.name, kind: c.kind, line: i + 1, column: c.column, signature: signatureOf(raw), depth: 0 });
  }
  return out.sort((a, b) => a.line - b.line || a.column - b.column).slice(0, FILE_SYMBOLS_MAX);
}

/**
 * Every declaration of the file at repo-relative `path` (its language by extension, §62's list; `.tld` has none), file
 * order. Never throws: what it cannot read is no symbol.
 */
export function extractSymbols(path: string, text: string): FileSymbol[] {
  const lang = langOf(path);
  if (!lang || lang === "tld") return [];
  const t = text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
  try {
    if (lang === "python") return pythonSymbols(t);
    if (lang === "vue") return vueSymbols(path, t);
    if (lang === "jsp") return jspSymbols(t);
    return braceSymbols(t, lang, lang === "js" ? { defaultObject: { name: stemOf(path), role: "object" } } : {});
  } catch {
    return [];
  }
}

/** Whether `kind` names a type (ranked first by `workspace_symbols`, a container for `find_definition`). */
export const isTypeKind = (kind: DefinitionKind): boolean => TYPE_KINDS.has(kind) && kind !== "file" && kind !== "tag";

// ---------------------------------------------------------------- definition_preview

const LANGUAGE_BY_EXT: Record<string, string> = {
  java: "java", kt: "kotlin", kts: "kotlin", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", vue: "vue", jsp: "jsp", jspf: "jsp", jspx: "jsp",
  tag: "jsp", tagx: "jsp", tld: "xml", xml: "xml", html: "html", htm: "html", css: "css", scss: "scss", less: "less",
  json: "json", yml: "yaml", yaml: "yaml", md: "markdown", swift: "swift", py: "python", pyi: "python", go: "go",
  sh: "shell", bash: "shell", zsh: "shell", sql: "sql", properties: "properties", gradle: "groovy", groovy: "groovy",
};

/** The language id a preview names for `path` (Monaco's ids where it has one), `plaintext` for anything else. */
export function languageOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? LANGUAGE_BY_EXT[base.slice(dot + 1).toLowerCase()] : undefined) ?? "plaintext";
}

const LEADING = /^\s*(?:\/\/|\/\*|\*|@[\w$.]|#|<%--|<!--|--%>|-->|"""|''')|^\s*$/;
const clampInt = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.floor(v))) : null;

/**
 * `definition_preview`: lines of a worktree file around 1-based `line` for a peek / hover — by default the comment /
 * annotation block right above it (≤ 20 lines) and 15 lines after; `before` / `after` override; never more than 80 lines in
 * all. `symbol`: the declaration on that line by §65's reading, when there is one.
 */
export function definitionPreview(root: string, opts: { path: unknown; line: unknown; before?: unknown; after?: unknown }): Omit<SymbolPreviewEvent, "type" | "id"> {
  const file = readProjectFile(root, opts.path);
  if (file.isBinary) throw new CommandRefused(`binary_file:${file.path}`, { code: "binary_file" });
  const total = file.lines.length;
  const line = clampInt(opts.line, 1, Number.MAX_SAFE_INTEGER);
  if (line === null || line > Math.max(1, total)) throw new CommandRefused(`line_out_of_range:${String(opts.line)}`, { code: "line_out_of_range" });
  let before = clampInt(opts.before, 0, PREVIEW_MAX_LINES - 1);
  if (before === null) {
    before = 0;
    while (before < PREVIEW_DEFAULT_BEFORE_MAX && line - before - 1 >= 1 && LEADING.test(file.lines[line - before - 2] ?? "")) before++;
    // Blank lines above the block are not part of it.
    while (before > 0 && (file.lines[line - before - 1] ?? "").trim() === "") before--;
  }
  const after = clampInt(opts.after, 0, PREVIEW_MAX_LINES - 1) ?? PREVIEW_DEFAULT_AFTER;
  const startLine = Math.max(1, line - before);
  const endLine = Math.min(total, line + after, startLine + PREVIEW_MAX_LINES - 1);
  const lines = file.lines.slice(startLine - 1, endLine);
  const sym = file.size <= 2 * 1024 * 1024 ? extractSymbols(file.path, file.lines.join("\n")).find((s) => s.line === line) : undefined;
  return {
    path: file.path, line, startLine, lines, totalLines: total, language: languageOf(file.path), truncated: file.truncated,
    ...(sym ? { symbol: { name: sym.name, kind: sym.kind, path: file.path, line: sym.line, column: sym.column, ...(sym.container ? { container: sym.container } : {}), ...(sym.signature ? { signature: sym.signature } : {}), ...(sym.endLine ? { endLine: sym.endLine } : {}) } } : {}),
  };
}
