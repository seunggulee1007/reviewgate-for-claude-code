import { describe, expect, it } from "vitest";
import { isOpenableGraphHtml } from "./graphOpen";
import { validateCommand } from "./ipcGuard";

/** wave5 w5-graph — docs/PROTOCOL.md §43.3: what main opens for [graph.html 열기], and the two new commands' allowlist. */

const file = { isFile: () => true };
const folder = { isFile: () => false };

describe("graph.html (§43.3)", () => {
  it("opens only graphify-out/graph.html that exists, by an absolute path without control characters", () => {
    const abs = process.platform === "win32" ? "C:\\w\\shop\\graphify-out\\graph.html" : "/w/shop/graphify-out/graph.html";
    expect(isOpenableGraphHtml(abs, () => file)).toBe(true);
    expect(isOpenableGraphHtml(abs, () => folder)).toBe(false);
    expect(isOpenableGraphHtml(abs, () => { throw new Error("ENOENT"); })).toBe(false);
    expect(isOpenableGraphHtml("graphify-out/graph.html", () => file)).toBe(false);
    expect(isOpenableGraphHtml("/w/shop/graph.html", () => file)).toBe(false);
    expect(isOpenableGraphHtml("/w/shop/graphify-out/evil.html", () => file)).toBe(false);
    expect(isOpenableGraphHtml("/w/shop/graphify-out/graph.html\n", () => file)).toBe(false);
    expect(isOpenableGraphHtml(42, () => file)).toBe(false);
  });

  it("the renderer may send code_graph and code_graph_build", () => {
    expect(validateCommand({ type: "code_graph" }).ok).toBe(true);
    expect(validateCommand({ type: "code_graph_build" }).ok).toBe(true);
  });
});
