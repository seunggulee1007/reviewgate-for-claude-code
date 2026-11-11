// MARK: wave5 w5-graph — docs/PROTOCOL.md §43.3: the code graph (graphify's GRAPH_REPORT.md), its freshness and the build.
import { chmodSync, mkdirSync, readFileSync, realpathSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildResultLine, CodeGraph, GODS_MAX, lastLine, parseGraphReport, type CodeGraphDeps } from "../src/board/codeGraph.js";
import type { CodeGraphEvent } from "../src/protocol.js";
import { makeBranchRepo, makeTempDir, removeDir, sh, write } from "./helpers/repo.js";
import { WAIT_MS } from "./helpers/wait.js";

/** A made-up report in graphify's layout (the names are invented; only the shape follows a real one). */
function report(commit = "1a2b3c4d", extra = ""): string {
  return `# Graph Report - shopfront  (2026-10-20)

## Corpus Check
- 1,204 files · ~310,552 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 9,876 nodes · 32,100 edges · 210 communities (150 shown, 60 thin omitted)
- Extraction: 91% EXTRACTED · 9% INFERRED · 0% AMBIGUOUS · INFERRED: 2890 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: \`${commit}\`
- Run \`git rev-parse HEAD\` and compare to check if the graph is stale.
- Run \`graphify update .\` after code changes (no API cost).

## Community Hubs (Navigation)
- OrderService
- CartController
- .toString
- .toString
- PaymentGateway

## God Nodes (most connected - your core abstractions)
1. \`OrderService\` - 1,230 edges
2. \`Money\` - 640 edges
3. \`CartItem\` - 77 edges

## Surprising Connections (you probably didn't know these)
- \`refund()\` --calls--> \`values()\`  [INFERRED]
  src/main/java/shop/pay/RefundPolicy.java → src/main/java/shop/stats/Report.java
- \`toCode()\` --references--> \`CodeDto\`  [EXTRACTED]
  src/main/java/shop/enums/Kind.java → src/main/java/shop/dto/CodeDto.java

## Import Cycles
- None detected.

## Communities (210 total, 60 thin omitted)

### Community 0 - "OrderService"
Cohesion: 0.02
Nodes (120): OrderService, OrderRepository, Money

### Community 1 - "CartController"
Cohesion: 0.11
Nodes (310): CartController, CartItem

### Community 2 - "PaymentGateway"
Nodes (45): PaymentGateway
${extra}
## Knowledge Gaps
- **812 isolated node(s):** \`A\`, \`B\` (+810 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
- **Why does \`OrderService\` connect \`Money\` to \`CartItem\`?**
`;
}

describe("parseGraphReport", () => {
  it("reads the counts, the commit, the hubs, the most connected nodes, the surprises and the largest communities", () => {
    const r = parseGraphReport(report());
    expect(r).toMatchObject({
      name: "shopfront",
      date: "2026-10-20",
      files: 1204,
      words: 310552,
      nodes: 9876,
      edges: 32100,
      communities: 210,
      extractedPct: 91,
      inferredPct: 9,
      ambiguousPct: 0,
      commit: "1a2b3c4d",
      hubs: ["OrderService", "CartController", ".toString", "PaymentGateway"],
      hubCount: 5,
      isolated: 812,
    });
    expect(r.gods).toEqual([
      { name: "OrderService", edges: 1230 },
      { name: "Money", edges: 640 },
      { name: "CartItem", edges: 77 },
    ]);
    expect(r.surprises).toEqual([
      { from: "refund()", relation: "calls", to: "values()", confidence: "INFERRED", fromFile: "src/main/java/shop/pay/RefundPolicy.java", toFile: "src/main/java/shop/stats/Report.java" },
      { from: "toCode()", relation: "references", to: "CodeDto", confidence: "EXTRACTED", fromFile: "src/main/java/shop/enums/Kind.java", toFile: "src/main/java/shop/dto/CodeDto.java" },
    ]);
    expect(r.bigCommunities).toEqual([
      { id: 1, name: "CartController", nodes: 310, cohesion: 0.11 },
      { id: 0, name: "OrderService", nodes: 120, cohesion: 0.02 },
      { id: 2, name: "PaymentGateway", nodes: 45, cohesion: null },
    ]);
  });

  it("reads Windows line ends the same, and a report without git, gods or communities as empty", () => {
    expect(parseGraphReport(report().replace(/\n/g, "\r\n"))).toEqual(parseGraphReport(report()));
    const small = "# Graph Report - gtest  (2026-10-24)\n\n## Summary\n- 10 nodes · 12 edges · 3 communities (0 shown, 2 thin omitted)\n";
    expect(parseGraphReport(small)).toMatchObject({ name: "gtest", nodes: 10, edges: 12, communities: 3, commit: null, gods: [], surprises: [], bigCommunities: [], hubs: [], hubCount: 0, files: null, isolated: null });
    expect(parseGraphReport("")).toMatchObject({ name: null, nodes: 0, edges: 0, communities: 0, extractedPct: null });
  });

  it("keeps at most 15 nodes and cuts long names", () => {
    const gods = Array.from({ length: 30 }, (_, i) => `${i + 1}. \`Node${i}${"x".repeat(i === 0 ? 400 : 0)}\` - ${100 - i} edges`).join("\n");
    const r = parseGraphReport(`## God Nodes (most connected)\n${gods}\n`);
    expect(r.gods).toHaveLength(GODS_MAX);
    expect(r.gods[0]!.name.length).toBeLessThanOrEqual(160);
    expect(r.gods[0]!.name.endsWith("…")).toBe(true);
  });
});

describe("graphify's output", () => {
  it("the result line is the rebuild line without graphify's tag; a failure's line wins over the last", () => {
    const ok = "Re-extracting code files in . (no LLM needed)...\n[graphify watch] Rebuilt: 10 nodes, 12 edges, 3 communities\n[graphify watch] graph.json, graph.html and GRAPH_REPORT.md updated in graphify-out\nCode graph updated.\n";
    expect(buildResultLine(ok)).toBe("Rebuilt: 10 nodes, 12 edges, 3 communities");
    expect(buildResultLine("Re-extracting…\nTraceback (most recent call last):\n  File x\nValueError: boom\n")).toBe("ValueError: boom");
    expect(buildResultLine("just one line\n")).toBe("just one line");
    expect(buildResultLine("")).toBe("");
    expect(lastLine("a\n[graphify watch] b\n\n")).toBe("b");
  });
});

// ---------------------------------------------------------------- the service against real repositories

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

function repo(): string {
  const dir = makeBranchRepo("rg-graph");
  dirs.push(dir);
  return dir;
}

function service(root: string | null, over: Partial<CodeGraphDeps> = {}): { graph: CodeGraph; emitted: CodeGraphEvent[] } {
  const emitted: CodeGraphEvent[] = [];
  const graph = new CodeGraph({
    root: () => root,
    graphify: async () => "/opt/fake/graphify",
    env: () => ({ ...process.env }),
    killTree: async (pid) => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    },
    isWindows: process.platform === "win32",
    emit: (ev) => emitted.push(ev),
    ...over,
  });
  return { graph, emitted };
}

function commitAll(dir: string, msg: string): string {
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", msg);
  return sh(dir, "rev-parse", "HEAD").trim();
}

async function until<T>(f: () => T | undefined, ms = WAIT_MS): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("CodeGraph", () => {
  it("without a project it is refused; a repository without a report says so, with graphify and the ignore state", async () => {
    await expect(service(null).graph.snapshot()).rejects.toMatchObject({ code: "no_project" });
    const dir = repo();
    const ev = await service(dir).graph.snapshot();
    expect(ev).toMatchObject({ type: "code_graph", root: dir, reportPath: null, report: null, builtAt: null, htmlPath: null, graphify: "/opt/fake/graphify", outIgnored: false, build: null, behind: null });
    expect(ev.head).toMatch(/^[0-9a-f]{8}$/);
    write(dir, ".gitignore", "graphify-out/\n");
    expect((await service(dir).graph.snapshot()).outIgnored).toBe(true);
  });

  it("counts the commits HEAD moved past the report's commit, re-reads the report when it changes and finds graph.html", async () => {
    const dir = repo();
    const base = sh(dir, "rev-parse", "HEAD").trim();
    write(dir, ".gitignore", "graphify-out/\n");
    write(dir, "graphify-out/GRAPH_REPORT.md", report(base.slice(0, 8)));
    const { graph } = service(dir);
    let ev = await graph.snapshot();
    expect(ev.reportPath).toBe(join(dir, "graphify-out", "GRAPH_REPORT.md"));
    expect(ev.shared).toBeUndefined();
    expect(ev.report?.nodes).toBe(9876);
    expect(ev.behind).toBe(0);
    expect(ev.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    commitAll(dir, "one");
    write(dir, "b.txt", "b\n");
    commitAll(dir, "two");
    ev = await graph.snapshot();
    expect(ev.behind).toBe(2);
    expect(ev.htmlPath).toBeNull();
    write(dir, "graphify-out/graph.html", "<html></html>");
    write(dir, "graphify-out/GRAPH_REPORT.md", report(base.slice(0, 8)).replace("9,876 nodes", "9,999 nodes"));
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(dir, "graphify-out", "GRAPH_REPORT.md"), later, later);
    ev = await graph.snapshot();
    expect(ev.report?.nodes).toBe(9999);
    expect(ev.htmlPath).toBe(join(dir, "graphify-out", "graph.html"));
    // A commit this repository does not have: unknown, not "fresh".
    write(dir, "graphify-out/GRAPH_REPORT.md", report("deadbeef"));
    const latest = new Date(Date.now() + 10_000);
    utimesSync(join(dir, "graphify-out", "GRAPH_REPORT.md"), latest, latest);
    expect((await graph.snapshot()).behind).toBeNull();
  });

  it("a linked worktree without a report of its own shows the main worktree's, marked shared", async () => {
    const main = repo();
    const head = sh(main, "rev-parse", "HEAD").trim();
    write(main, ".gitignore", "graphify-out/\n");
    commitAll(main, "ignore");
    write(main, "graphify-out/GRAPH_REPORT.md", report(head.slice(0, 8)));
    const linked = join(makeTempDir("rg-graph-wt"), "wt");
    dirs.push(linked);
    sh(main, "worktree", "add", "-q", "-b", "issue-1", linked);
    const ev = await service(linked).graph.snapshot();
    expect(ev.shared).toBe(true);
    expect(ev.reportPath).toBe(join(realpathSync(main), "graphify-out", "GRAPH_REPORT.md")); // the real path (/private/var on macOS)
    expect(ev.behind).toBe(1);
    expect(ev.outIgnored).toBe(true);
    expect(ev.root).toBe(linked);
  });

  it("a build is refused without graphify, while git would see graphify-out/, and while one runs", async () => {
    const dir = repo();
    await expect(service(dir, { graphify: async () => null }).graph.startBuild()).rejects.toMatchObject({ code: "graphify_missing" });
    await expect(service(dir).graph.startBuild()).rejects.toMatchObject({ code: "graph_out_not_ignored" });
    await expect(service(null).graph.startBuild()).rejects.toMatchObject({ code: "no_project" });
  });

  it.skipIf(process.platform === "win32")("runs `graphify update .` in the root with GRAPHIFY_NO_TIPS, emits its progress and the new report", async () => {
    const dir = repo();
    write(dir, ".gitignore", "graphify-out/\n");
    const bin = join(makeTempDir("rg-graph-bin"), "graphify");
    dirs.push(join(bin, ".."));
    // graphify waits (≤ 10 s) for the go file the test writes once the reply is in. Without it a fast /bin/sh (CI's
    // ubuntu runner) printed its first line before the reply's snapshot (its git calls) was there to send it with.
    const go = join(bin, "..", "go");
    write(join(bin, ".."), "graphify", `#!/bin/sh
[ "$1" = update ] && [ "$2" = . ] || exit 64
i=0; while [ ! -f '${go}' ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done
echo "Re-extracting code files in . (no LLM needed)..."
mkdir -p graphify-out
printf '# Graph Report - fake  (2026-10-24)\\n\\n## Summary\\n- 3 nodes · 2 edges · 1 communities\\n- Built tips=%s\\n' "$GRAPHIFY_NO_TIPS" > graphify-out/GRAPH_REPORT.md
sleep 0.3
echo "[graphify watch] Rebuilt: 3 nodes, 2 edges, 1 communities"
`);
    chmodSync(bin, 0o755);
    const { graph, emitted } = service(dir, { graphify: async () => bin, progressMs: 10 });
    const started = await graph.startBuild();
    expect(started.build).toMatchObject({ running: true });
    await expect(graph.startBuild()).rejects.toMatchObject({ code: "graph_build_running" });
    write(join(bin, ".."), "go", "");
    const end = await until(() => emitted.find((e) => e.build && !e.build.running));
    expect(end.build).toMatchObject({ running: false, ok: true, exitCode: 0, line: "Rebuilt: 3 nodes, 2 edges, 1 communities" });
    expect(end.report?.nodes).toBe(3);
    expect(readFileSync(join(dir, "graphify-out", "GRAPH_REPORT.md"), "utf8")).toContain("Built tips=1"); // GRAPHIFY_NO_TIPS=1
    expect(end.reportPath).toBe(join(dir, "graphify-out", "GRAPH_REPORT.md"));
    expect(emitted.some((e) => e.build?.running && e.build.line === "Re-extracting code files in . (no LLM needed)...")).toBe(true);
    expect(graph.isBuilding).toBe(false);
    expect((await graph.snapshot()).build).toMatchObject({ ok: true });
  });

  it.skipIf(process.platform === "win32")("a build that outlives its limit is stopped and says so", async () => {
    const dir = repo();
    write(dir, ".gitignore", "graphify-out/\n");
    const binDir = makeTempDir("rg-graph-bin");
    dirs.push(binDir);
    write(binDir, "graphify", "#!/bin/sh\necho working\nsleep 30\n");
    chmodSync(join(binDir, "graphify"), 0o755);
    const { graph, emitted } = service(dir, { graphify: async () => join(binDir, "graphify"), timeoutMs: 400 });
    await graph.startBuild();
    const end = await until(() => emitted.find((e) => e.build && !e.build.running));
    expect(end.build).toMatchObject({ running: false, ok: false, exitCode: null, timedOut: true });
  });

  it("stop() during a build and reset() leave nothing running", async () => {
    const dir = repo();
    mkdirSync(join(dir, "graphify-out"), { recursive: true });
    const { graph } = service(dir);
    graph.reset();
    expect(graph.isBuilding).toBe(false);
  });
});
