import { describe, expect, it } from "vitest";
import { projectRootHash } from "../shared/hash.js";
import { linesOf, mergedAllowPatterns } from "./projectPatterns.js";

describe("allow patterns sent to the engine (§33.6)", () => {
  it("passes MCP / WebFetch / WebSearch entries through with the Bash ones, global first, deduplicated", () => {
    const root = "/Users/me/acme";
    const perProject = { [projectRootHash(root)]: "mcp__github__*\nWebFetch(domain:docs.spring.io)\nBash(make:*)", "0badc0de": "mcp__other__*" };
    expect(mergedAllowPatterns("Bash(make:*)\n# comment\n\nWebSearch", perProject, root)).toEqual(["Bash(make:*)", "WebSearch", "mcp__github__*", "WebFetch(domain:docs.spring.io)"]);
    // another project's list never leaks in
    expect(mergedAllowPatterns("", perProject, "/Users/me/other")).toEqual([]);
    expect(linesOf("  mcp__a__b  \r\n#x\n")).toEqual(["mcp__a__b"]);
  });
});
