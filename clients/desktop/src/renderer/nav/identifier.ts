/**
 * §62 — the name under the pointer / caret in a line of code, as `find_definition` takes it: an identifier (`total`,
 * `CartService`, `$store`), a qualified name in an import / package line or a `pkg.Type` chain (`com.acme.CartService`),
 * a kebab-case tag name in a Vue / HTML template (`<my-widget`), a JSP custom tag (`<ui:panel`), or the contents of a
 * quoted include / import path (`"/WEB-INF/views/row.jspf"`, `'./components/Foo.vue'`). Pure: the diff views, the full
 * file view and the project file view all call it with the line's text and the character offset.
 */

export type NavSymbol = {
  symbol: string;
  start: number;
  end: number;
  /** §65.6: the name before `x.` / `x?.` / `x!!.` / `x::` / `x->` right in front of a plain identifier (`this`, `user`, `CartService`). */
  receiver?: string;
};

const PATH_EXT = /\.(?:jspf?|jspx|tagx?|vue|jsx?|tsx?|mjs|cjs|html|css|scss|less|xml|json|properties|ya?ml)$/i;
const WORD = /[A-Za-z0-9_$]/;
/** What the engine accepts at all (§62 `symbol`): printable ASCII without spaces or parentheses, 1–200 characters. */
const SENDABLE = /^[\x21-\x27\x2a-\x7e]{1,200}$/;

/** Words no definition search is worth: the languages' keywords and literals (Java, Kotlin, JS / TS). */
const KEYWORDS = new Set(
  (
    "abstract async await boolean break byte case catch char class const continue default do double else enum export " +
    "extends false final finally float for function fun if implements import in instanceof int interface let long new " +
    "null package private protected public return short static super switch synchronized this throw throws true try " +
    "typeof val var void volatile while yield undefined"
  ).split(" "),
);

/** Whether `symbol` may be sent as `find_definition.symbol` (the engine refuses anything else `bad_symbol`). */
export function isSendableSymbol(symbol: string): boolean {
  return SENDABLE.test(symbol);
}

/** The name at `offset` (a character index into `text`; the character right before it when the pointer is just past a word). */
export function identifierAt(text: string, offset: number, path = ""): NavSymbol | null {
  if (offset < 0 || offset > text.length) return null;
  const quoted = quotedPathAt(text, offset);
  if (quoted) return quoted;
  let at = offset;
  if (!isWordChar(text[at]) && isWordChar(text[at - 1])) at -= 1;
  if (!isWordChar(text[at])) return null;

  const tag = tagNameAt(text, at, path);
  if (tag) return tag;

  let start = at;
  while (start > 0 && isWordChar(text[start - 1])) start -= 1;
  let end = at + 1;
  while (end < text.length && isWordChar(text[end])) end += 1;
  const word = text.slice(start, end);
  if (!/^[A-Za-z_$]/.test(word) || KEYWORDS.has(word)) return null;

  const qualified = qualifiedAt(text, start, end);
  if (qualified) return qualified;
  const receiver = receiverBefore(text, start);
  return receiver ? { symbol: word, start, end, receiver } : { symbol: word, start, end };
}

/**
 * §65.6 — the receiver of the word starting at `start`: the identifier right before `.` / `?.` / `!!.` (spaces around
 * allowed) or `::` / `->` (none: `it -> save(it)` is a lambda). Nothing after `)` / `]` (`foo().bar`: its type is not
 * known) or a number.
 */
export function receiverBefore(text: string, start: number): string | undefined {
  const m = /([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*(?:\?\.|!!\.|\.)\s*|::|->)$/.exec(text.slice(0, start));
  if (!m) return undefined;
  const before = text[m.index - 1];
  return before !== undefined && isWordChar(before) ? undefined : m[1];
}

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && WORD.test(c);
}

function isTagChar(c: string | undefined): boolean {
  return c === "-" || c === ":";
}

/** The contents of the quoted string around `offset` when it reads as a path (a `/` in it, or a known file extension). */
function quotedPathAt(text: string, offset: number): NavSymbol | null {
  for (const q of ['"', "'", "`"]) {
    let open = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== q || text[i - 1] === "\\") continue;
      if (open < 0) {
        open = i;
        continue;
      }
      if (offset > open && offset <= i) {
        const inner = text.slice(open + 1, i);
        const trimmed = inner.trim();
        if (!trimmed || !(trimmed.includes("/") || PATH_EXT.test(trimmed)) || !isSendableSymbol(trimmed) || /[<>{}$]/.test(trimmed)) return null;
        const start = open + 1 + inner.indexOf(trimmed);
        return { symbol: trimmed, start, end: start + trimmed.length };
      }
      open = -1;
    }
  }
  return null;
}

/** `<my-widget` / `</my-widget` (kebab-case: a Vue component by its file name) and `<ui:panel` (a JSP custom tag). */
function tagNameAt(text: string, at: number, path: string): NavSymbol | null {
  let start = at;
  while (start > 0 && (isWordChar(text[start - 1]) || isTagChar(text[start - 1]))) start -= 1;
  let end = at + 1;
  while (end < text.length && (isWordChar(text[end]) || isTagChar(text[end]))) end += 1;
  const run = text.slice(start, end);
  const opens = text[start - 1] === "<" || (text[start - 1] === "/" && text[start - 2] === "<");
  if (!opens) return null;
  if (/^[A-Za-z_][\w-]*:[A-Za-z_][\w-]*$/.test(run)) {
    // `jsp:include`, `c:if`, `spring:message` … are the container's / JSTL's: the include path or the attribute says more.
    if (/^(?:jsp|c|fn|fmt|sql|x|spring|form|sec|tiles):/.test(run) && !/\.tagx?$/.test(path)) return null;
    return { symbol: run, start, end };
  }
  if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(run)) return { symbol: run, start, end };
  return null;
}

/**
 * `a.b.C` when it names a type through its package: in a Java / Kotlin `import` / `package` line, or a chain of lower-case
 * parts ending in the capitalised clicked one (`com.acme.Cart.total()` clicked on `Cart`). Elsewhere (`this.total`,
 * `user.name`) the plain word: the receiver says nothing about where the member is defined.
 */
function qualifiedAt(text: string, start: number, end: number): NavSymbol | null {
  let from = start;
  while (from >= 2 && text[from - 1] === "." && isWordChar(text[from - 2])) {
    let s = from - 2;
    while (s > 0 && isWordChar(text[s - 1])) s -= 1;
    from = s;
  }
  if (from === start) return null;
  const chain = text.slice(from, end);
  const parts = chain.split(".");
  const importLine = /^\s*(?:import|package)\s+(?:static\s+)?$/.test(text.slice(0, from));
  const typeChain = parts.slice(0, -1).every((p) => /^[a-z_][a-z0-9_]*$/.test(p)) && /^[A-Z]/.test(parts[parts.length - 1]!);
  if (!importLine && !typeChain) return null;
  if (!parts.every((p) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p))) return null;
  return { symbol: chain, start: from, end };
}
