import { describe, expect, it } from "vitest";
import { sourceHelp, sourceLabel } from "./navSource";

/** docs/PROTOCOL.md §73.5: "Exact" / "Estimated" and why. */
describe("navSource", () => {
  it("labels the language server's answer exact, the search's (and an older engine's) estimated", () => {
    expect(sourceLabel("lsp")).not.toBe(sourceLabel("grep"));
    expect(sourceLabel(undefined)).toBe(sourceLabel("grep"));
  });

  it("says why the search answered, one reason per fallback", () => {
    const reasons = new Set([
      sourceHelp("lsp", undefined),
      sourceHelp("grep", "starting"),
      sourceHelp("grep", "timeout"),
      sourceHelp("grep", "failed"),
      sourceHelp("grep", "no_result"),
      sourceHelp("grep", "off"),
      sourceHelp("grep", undefined),
    ]);
    expect(reasons.size).toBe(7);
    expect(sourceHelp("grep", "unavailable")).toBe(sourceHelp("grep", "failed"));
  });
});
