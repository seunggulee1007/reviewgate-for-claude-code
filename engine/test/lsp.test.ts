import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitFiles } from "../src/files/symbolIndex.js";
import { chooseTsServer, findBundle, usableTypeScript, type LspBundle } from "../src/lsp/locate.js";
import { kindOf, LspService, type LspServiceOptions } from "../src/lsp/service.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §73: the language server for JS / TS / Vue (real tsserver from the dev workspace, fixtures in temp dirs). */

const bundle = findBundle();
const dirs: string[] = [];
const services: LspService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) removeDir(d);
});

function project(files: Record<string, string>): string {
  const dir = makeTempDir("rg-lsp");
  dirs.push(dir);
  sh(dir, "init", "-q");
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  return dir;
}

function service(root: string, extra: Partial<LspServiceOptions> = {}): LspService {
  const s = new LspService({ root, bundle: () => bundle, listFiles: () => gitFiles(root), onChange: () => undefined, ...extra });
  services.push(s);
  return s;
}

const TS_FILES: Record<string, string> = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true }, include: ["src"] }),
  "src/lib/math.ts": "/** Adds two numbers. */\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n",
  "src/index.ts": "export { add } from './lib/math';\n",
  "src/app.ts": "import { add } from './index';\n\nconst three = add(1, 2);\nexport { three };\n",
  "src/other.ts": "import { add as plus } from './lib/math';\nexport const four = plus(2, 2);\n",
};

const VUE_FILES: Record<string, string> = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true, jsx: "preserve" }, include: ["src/**/*.ts", "src/**/*.vue"] }),
  "src/util.ts": "export function formatPrice(n: number): string {\n  return `$${n.toFixed(2)}`;\n}\n",
  "src/components/PriceTag.vue": "<script setup lang=\"ts\">\nimport { formatPrice } from '../util';\nconst props = defineProps<{ amount: number }>();\nconst label = formatPrice(props.amount);\nfunction shout(s: string) { return s.toUpperCase(); }\n</script>\n\n<template>\n  <span>{{ shout(label) }}</span>\n</template>\n",
  "src/App.vue": "<script setup lang=\"ts\">\nimport PriceTag from './components/PriceTag.vue';\nimport { formatPrice } from './util';\nconst total = formatPrice(10);\n</script>\n\n<template>\n  <PriceTag :amount=\"3\" />\n  <p>{{ total }}</p>\n</template>\n",
  "src/main.ts": "import App from './App.vue';\nconsole.log(App);\n",
};

const JS_FILES: Record<string, string> = {
  "lib/math.js": "export function add(a, b) {\n  return a + b;\n}\n",
  "lib/index.js": "export { add } from './math.js';\n",
  "app.js": "import { add } from './lib/index.js';\nconsole.log(add(1, 2));\n",
  "other.js": "import { add } from './lib/math.js';\nexport const three = add(1, 2);\n",
  "vendor/jquery.js": "function add() {}\n",
};

describe.skipIf(!bundle)("§73 the language server", () => {
  it("finds the dev workspace's bundle: TypeScript 6 and the Vue plugin", () => {
    expect(bundle!.typescriptVersion).toMatch(/^6\./);
  });

  it("TS: a definition through a re-export, its quickinfo; references across files and aliases", async () => {
    const root = project(TS_FILES);
    const s = service(root);
    const d = await s.definition({ symbol: "add", fromPath: "src/app.ts", line: 3, column: 15 });
    expect(d).toMatchObject({ ok: true, symbol: "add" });
    if (!d.ok) return;
    expect(d.candidates.map((c) => `${c.path}:${c.line}:${c.column}:${c.kind}`)).toEqual(["src/lib/math.ts:2:17:function"]);
    expect(d.candidates[0]!.preview).toBe("export function add(a: number, b: number): number {");
    expect(d.quickInfo?.display).toContain("add(a: number, b: number): number");
    expect(s.state).toMatchObject({ status: "ready", typescript: { source: "bundled" } });

    const r = await s.references({ symbol: "add", fromPath: "src/lib/math.ts", line: 2, column: 17 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The clicked file first (its definition marked), then the rest by path, line order; a comment would not count.
    expect(r.hits.map((h) => `${h.path}:${h.line}${h.kind ? `:${h.kind}` : ""}`)).toEqual([
      "src/lib/math.ts:2:function", "src/app.ts:1", "src/app.ts:3", "src/index.ts:1", "src/other.ts:1", "src/other.ts:2",
    ]);
    expect(r.files).toBe(4);
    expect(r.truncated).toBe(false);
    const limited = await s.references({ symbol: "add", fromPath: "src/lib/math.ts", line: 2, limit: 2 });
    expect(limited).toMatchObject({ ok: true, truncated: true });
  });

  it("Vue: a component in the template, a <script setup> const, a .ts function from a .vue file", async () => {
    const root = project(VUE_FILES);
    const s = service(root);
    const tag = await s.definition({ symbol: "PriceTag", fromPath: "src/App.vue", line: 8, column: 4 });
    expect(tag.ok && tag.candidates.map((c) => `${c.path}:${c.line}:${c.kind}`)).toEqual(["src/components/PriceTag.vue:1:component"]);
    const total = await s.definition({ symbol: "total", fromPath: "src/App.vue", line: 9, column: 9 });
    expect(total.ok && total.candidates.map((c) => `${c.path}:${c.line}:${c.column}`)).toEqual(["src/App.vue:4:7"]);
    const fn = await s.definition({ symbol: "formatPrice", fromPath: "src/components/PriceTag.vue", line: 4, column: 15 });
    expect(fn.ok && fn.candidates.map((c) => `${c.path}:${c.line}`)).toEqual(["src/util.ts:1"]);
    const inTemplate = await s.definition({ symbol: "shout", fromPath: "src/components/PriceTag.vue", line: 9 });
    expect(inTemplate.ok && inTemplate.candidates.map((c) => `${c.path}:${c.line}`)).toEqual(["src/components/PriceTag.vue:5"]);
    const refs = await s.references({ symbol: "formatPrice", fromPath: "src/util.ts", line: 1, column: 17 });
    expect(refs.ok && refs.hits.map((h) => `${h.path}:${h.line}`)).toEqual(["src/util.ts:1", "src/App.vue:3", "src/App.vue:4", "src/components/PriceTag.vue:2", "src/components/PriceTag.vue:4"]);
  });

  it("JS without a tsconfig: the implicit project sees files the clicked one does not import; vendored ones stay out", async () => {
    const root = project(JS_FILES);
    const s = service(root);
    const d = await s.definition({ symbol: "add", fromPath: "app.js", line: 2, column: 13 });
    expect(d.ok && d.candidates.map((c) => `${c.path}:${c.line}:${c.kind}`)).toEqual(["lib/math.js:1:function"]);
    const r = await s.references({ symbol: "add", fromPath: "lib/math.js", line: 1, column: 17 });
    expect(r.ok && r.hits.map((h) => h.path)).toEqual(["lib/math.js", "lib/index.js", "app.js", "app.js", "other.js", "other.js"]);
    expect(r.ok && r.files).toBe(4);
  });

  it("reads the working tree: a changed file is answered as it is on disk now", async () => {
    const root = project(TS_FILES);
    const s = service(root);
    expect((await s.definition({ symbol: "three", fromPath: "src/app.ts", line: 4, column: 10 })).ok).toBe(true);
    // The clicked file changes (an edit the review shows): its new line is what is asked about.
    writeFileSync(join(root, "src/app.ts"), "import { add } from './index';\n\n\n\nconst three = add(1, 2);\nexport { three };\n");
    const d = await s.definition({ symbol: "three", fromPath: "src/app.ts", line: 6, column: 10 });
    expect(d.ok && d.candidates.map((c) => `${c.path}:${c.line}`)).toEqual(["src/app.ts:5"]);
  });

  it("a file it did not open, changed on disk, is read again (tsserver's own watcher)", async () => {
    const root = project(TS_FILES);
    const s = service(root);
    const before = await s.definition({ symbol: "add", fromPath: "src/app.ts", line: 3 });
    expect(before.ok && before.candidates[0]!.line).toBe(2);
    writeFileSync(join(root, "src/lib/math.ts"), "// moved\n// down\n/** Adds two numbers. */\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n");
    let line = 0;
    await until(async () => {
      const d = await s.definition({ symbol: "add", fromPath: "src/app.ts", line: 3 });
      line = d.ok ? d.candidates[0]!.line : 0;
      return line === 4;
    });
    expect(line).toBe(4);
  });

  it("a monorepo: each package's own tsconfig, a definition across packages", async () => {
    const root = project({
      "package.json": JSON.stringify({ private: true, workspaces: ["packages/*"] }),
      "packages/core/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler", composite: true }, include: ["src"] }),
      "packages/core/src/money.ts": "export class Money {\n  constructor(readonly cents: number) {}\n}\n",
      "packages/web/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler" }, include: ["src"], references: [{ path: "../core" }] }),
      "packages/web/src/cart.ts": "import { Money } from '../../core/src/money';\nexport const total = new Money(100);\n",
    });
    const s = service(root);
    const d = await s.definition({ symbol: "Money", fromPath: "packages/web/src/cart.ts", line: 2, column: 25 });
    // `new Money(…)`: the constructor and the class, as VS Code lists them.
    expect(d.ok && d.candidates.map((c) => `${c.path}:${c.line}:${c.kind}`)).toEqual(["packages/core/src/money.ts:2:constructor", "packages/core/src/money.ts:1:class"]);
    const r = await s.references({ symbol: "Money", fromPath: "packages/core/src/money.ts", line: 1, column: 14 });
    expect(r.ok && r.files).toBe(2);
  });

  it("falls back: no position, not JS / TS / Vue, off, a library outside the project, unavailable", async () => {
    const root = project({ ...TS_FILES, "src/Main.java": "class Main { void add() {} }\n", "src/dom.ts": "document.title = 'x';\n" });
    const s = service(root);
    expect(await s.definition({ symbol: "add", fromPath: "src/Main.java", line: 1 })).toEqual({ ok: false, fallback: null });
    expect(await s.definition({ symbol: "add", fromPath: "src/app.ts" })).toEqual({ ok: false, fallback: null });
    expect(await s.definition({ symbol: "nothere", fromPath: "src/app.ts", line: 3 })).toEqual({ ok: false, fallback: null });
    expect(await s.definition({ symbol: "document", fromPath: "src/dom.ts", line: 1 })).toEqual({ ok: false, fallback: "no_result" }); // lib.dom.d.ts
    s.setEnabled(false);
    expect(await s.definition({ symbol: "add", fromPath: "src/app.ts", line: 3 })).toEqual({ ok: false, fallback: "off" });
    expect(s.state).toBeUndefined();
    const none = service(root, { bundle: () => null });
    expect(await none.definition({ symbol: "add", fromPath: "src/app.ts", line: 3 })).toEqual({ ok: false, fallback: "unavailable" });
    expect(none.state).toMatchObject({ status: "unavailable", error: expect.stringContaining("not part of this build") });
  });

  it("a start that takes longer than the budget falls back `starting`; the next request has it", async () => {
    const root = project(TS_FILES);
    const s = service(root, { timing: { definitionMs: 5 } });
    expect(await s.definition({ symbol: "add", fromPath: "src/app.ts", line: 3 })).toEqual({ ok: false, fallback: "starting" });
    await until(() => s.state?.status === "ready");
    expect(s.state?.status).toBe("ready");
  });

  it("restarts after a crash with backoff, counts it, and gives up after the limit", async () => {
    const root = project(TS_FILES);
    const changes: string[] = [];
    const s = service(root, { timing: { backoffBaseMs: 10, crashLimit: 2 }, onChange: () => changes.push(s.state?.status ?? "idle") });
    expect((await s.definition({ symbol: "add", fromPath: "src/app.ts", line: 3 })).ok).toBe(true);
    const first = s.process!;
    first.crash();
    await until(() => s.state?.status === "ready" && s.process !== first);
    expect(s.state).toMatchObject({ status: "ready", restarts: 1 });
    expect((await s.definition({ symbol: "add", fromPath: "src/app.ts", line: 3 })).ok).toBe(true);
    s.process!.crash();
    await until(() => s.state?.status === "failed");
    expect(s.state).toMatchObject({ status: "failed", restarts: 2, error: expect.stringContaining("stopped 2 times") });
    expect(await s.definition({ symbol: "add", fromPath: "src/app.ts", line: 3 })).toEqual({ ok: false, fallback: "failed" });
    expect(changes).toContain("starting");
    // Off and on again forgets it.
    s.setEnabled(false);
    s.setEnabled(true);
    expect((await s.definition({ symbol: "add", fromPath: "src/app.ts", line: 3 })).ok).toBe(true);
  });

  it("stops when idle; the next request starts it again", async () => {
    const root = project(TS_FILES);
    const s = service(root, { timing: { idleMs: 1_000 } });
    expect((await s.definition({ symbol: "add", fromPath: "src/app.ts", line: 3 })).ok).toBe(true);
    const proc = s.process!;
    await until(() => !proc.alive);
    expect(s.state).toBeUndefined();
    expect((await s.definition({ symbol: "add", fromPath: "src/app.ts", line: 3 })).ok).toBe(true);
  });
});

describe("§73 timeouts and crashes against a fake tsserver", () => {
  /** A tsserver that answers the start and `updateOpen`, then never answers (`hang`) or dies (`die`) on a definition. */
  function fakeBundle(mode: "hang" | "die"): LspBundle {
    const dir = makeTempDir("rg-lsp-fake");
    dirs.push(dir);
    const script = join(dir, "tsserver.js");
    writeFileSync(script, [
      "const rl = require('readline').createInterface({ input: process.stdin });",
      "const send = (o) => { const s = JSON.stringify(o); process.stdout.write(`Content-Length: ${Buffer.byteLength(s)}\\r\\n\\r\\n${s}`); };",
      "rl.on('line', (l) => { const m = JSON.parse(l);",
      `  if (m.command === 'definitionAndBoundSpan' || m.command === 'references') { if (${JSON.stringify(mode)} === 'die') process.exit(3); return; }`,
      "  if (m.command === 'quickinfo') return;",
      "  send({ seq: 0, type: 'response', request_seq: m.seq, command: m.command, success: true, body: true }); });",
    ].join("\n"));
    return { tsserver: script, pluginProbe: dir, typescriptVersion: "6.0.3" };
  }

  it("a server that does not answer in time: `timeout` (it was ready), the reply dropped", async () => {
    const root = project(TS_FILES);
    const fake = fakeBundle("hang");
    const s = service(root, { bundle: () => fake, timing: { definitionMs: 400, referencesMs: 400 } });
    s.warm("src/app.ts");
    await until(() => s.state?.status === "ready");
    expect(await s.definition({ symbol: "add", fromPath: "src/app.ts", line: 3 })).toEqual({ ok: false, fallback: "timeout" });
    expect(await s.references({ symbol: "add", fromPath: "src/app.ts", line: 3 })).toEqual({ ok: false, fallback: "timeout" });
  });

  it("a server that dies during a request: `failed`, then it is started again", async () => {
    const root = project(TS_FILES);
    const fake = fakeBundle("die");
    const s = service(root, { bundle: () => fake, timing: { backoffBaseMs: 10 } });
    expect(await s.definition({ symbol: "add", fromPath: "src/app.ts", line: 3 })).toEqual({ ok: false, fallback: "failed" });
    await until(() => s.state?.status === "ready");
    expect(s.state).toMatchObject({ status: "ready", restarts: 1 });
  });
});

describe("§73.1 which TypeScript", () => {
  it("the project's own 5.x / 6.x when installed (not committed), else the bundle's", () => {
    const root = project({});
    const b: LspBundle = { tsserver: "/bundle/tsserver.js", pluginProbe: "/bundle", typescriptVersion: "6.0.3" };
    expect(chooseTsServer(root, b, new Set())).toMatchObject({ tsserver: "/bundle/tsserver.js", typescript: { version: "6.0.3", source: "bundled" } });
    write(root, "node_modules/typescript/package.json", JSON.stringify({ version: "5.4.5" }));
    write(root, "node_modules/typescript/lib/tsserver.js", "");
    expect(chooseTsServer(root, b, new Set())).toMatchObject({ tsserver: join(root, "node_modules/typescript/lib/tsserver.js"), pluginProbe: "/bundle", typescript: { version: "5.4.5", source: "project" } });
    expect(chooseTsServer(root, b, new Set(["node_modules/typescript/package.json"])).typescript.source).toBe("bundled"); // committed into git
    write(root, "node_modules/typescript/package.json", JSON.stringify({ version: "4.9.5" }));
    expect(chooseTsServer(root, b, new Set()).typescript.source).toBe("bundled");
    expect(usableTypeScript("5.0.2")).toBe(true);
    expect(usableTypeScript("6.0.3")).toBe(true);
    expect(usableTypeScript("7.0.2")).toBe(false); // the native port: no tsserver protocol, no plugins
    expect(usableTypeScript("4.9.5")).toBe(false);
  });

  it("maps tsserver's kinds to §62's", () => {
    expect(kindOf("class")).toBe("class");
    expect(kindOf("const")).toBe("variable");
    expect(kindOf("enum member")).toBe("constant");
    expect(kindOf("local function")).toBe("function");
    expect(kindOf("getter")).toBe("property");
    expect(kindOf("keyword")).toBeNull();
  });
});

async function until(pred: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}
