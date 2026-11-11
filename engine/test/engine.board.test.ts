// MARK: wave5 w5-graph — docs/PROTOCOL.md §43.3 through the engine: `code_graph`, `code_graph_build`, `extensions.mods`.
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeGraphEvent } from "../src/protocol.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeBranchRepo, makeTempDir, removeDir, sh, write } from "./helpers/repo.js";
import { WAIT_MS } from "./helpers/wait.js";

const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function repo(): string {
  const dir = makeBranchRepo("rg-board");
  dirs.push(dir);
  return dir;
}

describe("§43.3 code graph through the engine", () => {
  it("code_graph needs a project and replies with the report's summary; old clients' commands are untouched", async () => {
    const h = makeHarness({ graphifyPath: null });
    harnesses.push(h);
    await h.hello();
    await expect(h.engine.request({ type: "code_graph" })).rejects.toThrow(/no_project/);
    const dir = repo();
    const head = sh(dir, "rev-parse", "HEAD").trim();
    write(dir, ".gitignore", "graphify-out/\n");
    write(dir, "graphify-out/GRAPH_REPORT.md", `# Graph Report - demo  (2026-10-24)\n\n## Summary\n- 12 nodes · 30 edges · 2 communities\n\n## Graph Freshness\n- Built from commit: \`${head.slice(0, 8)}\`\n`);
    await h.open(dir);
    const ev: CodeGraphEvent = await h.engine.request({ type: "code_graph" });
    expect(ev).toMatchObject({ type: "code_graph", root: h.engine.state.project?.root, graphify: null, outIgnored: true, behind: 0, build: null });
    expect(ev.report).toMatchObject({ name: "demo", nodes: 12, edges: 30, communities: 2, commit: head.slice(0, 8) });
    // Without graphify the build is refused (the clients show it disabled with the reason).
    await expect(h.engine.request({ type: "code_graph_build" })).rejects.toThrow(/graphify_missing/);
  });

  it.skipIf(process.platform === "win32")("code_graph_build replies at once and emits the finished build with the new report", async () => {
    const bin = makeTempDir("rg-board-bin");
    dirs.push(bin);
    // graphify waits (≤ 10 s) for the go file the test writes once the reply is in. Without it a fast /bin/sh (CI's
    // ubuntu runner) finished the build before the reply's snapshot (its git calls) and the reply showed it ended.
    const go = join(bin, "go");
    write(
      bin,
      "graphify",
      "#!/bin/sh\n" +
        `i=0; while [ ! -f '${go}' ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done\n` +
        "mkdir -p graphify-out\nprintf '# Graph Report - built  (2026-10-24)\\n\\n## Summary\\n- 5 nodes · 4 edges · 1 communities\\n' > graphify-out/GRAPH_REPORT.md\necho '[graphify watch] Rebuilt: 5 nodes, 4 edges, 1 communities'\n",
    );
    chmodSync(join(bin, "graphify"), 0o755);
    const h = makeHarness({ graphifyPath: join(bin, "graphify") });
    harnesses.push(h);
    await h.hello();
    const dir = repo();
    // Not ignored: refused, nothing runs.
    await h.open(dir);
    await expect(h.engine.request({ type: "code_graph_build" })).rejects.toThrow(/graph_out_not_ignored/);
    write(dir, ".gitignore", "graphify-out/\n");
    const started = await h.engine.request({ type: "code_graph_build" });
    expect(started.build).toMatchObject({ running: true });
    write(bin, "go", "");
    const done = await new Promise<CodeGraphEvent>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no finished build")), WAIT_MS);
      const check = () => {
        const ev = h.ofType("code_graph").find((e) => e.build && !e.build.running && e.id === undefined);
        if (ev) {
          clearTimeout(t);
          resolve(ev);
        } else setTimeout(check, 20);
      };
      check();
    });
    expect(done.build).toMatchObject({ ok: true, line: "Rebuilt: 5 nodes, 4 edges, 1 communities" });
    expect(done.report?.nodes).toBe(5);
    expect(readFileSync(join(dir, "graphify-out", "GRAPH_REPORT.md"), "utf8")).toContain("built");
  });

  it("extensions.mods lists the user's dev-mods (read only) and is absent without any", async () => {
    const config = makeTempDir("rg-board-config");
    dirs.push(config);
    write(config, "dev-mods/sess-1/demo-board/.claude-plugin/plugin.json", JSON.stringify({ name: "demo-board", description: "샘플 보드", version: "0.1.0" }));
    write(config, "dev-mods/sess-1/demo-board/hooks/hooks.json", JSON.stringify({ modules: ["./register.tsx"] }));
    const h = makeHarness({ env: { CLAUDE_CONFIG_DIR: config } });
    harnesses.push(h);
    await h.hello();
    const s = await h.open(repo());
    const ext = (await h.waitFor((x) => x.session.extensions !== null, "extensions")).session.extensions!;
    expect(s.session.open).toBe(true);
    expect(ext.mods).toEqual([
      { name: "demo-board", description: "샘플 보드", version: "0.1.0", path: join(config, "dev-mods", "sess-1", "demo-board"), source: "dev", sessionId: "sess-1", loaded: false, hasHooks: true },
    ]);
    const plain = makeHarness();
    harnesses.push(plain);
    await plain.hello();
    await plain.open(repo());
    const ext2 = (await plain.waitFor((x) => x.session.extensions !== null, "extensions")).session.extensions!;
    expect(ext2.mods).toBeUndefined();
  });
});
