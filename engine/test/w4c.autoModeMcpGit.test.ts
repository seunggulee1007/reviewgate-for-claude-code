// MARK: wave4c w4c-trust — §41.2: in auto mode an MCP tool that writes into a `.git` folder keeps the card, like Bash (§40.1).
import { describe, expect, it } from "vitest";
import { autoModeDecides, autoModeKeepsMcpCard } from "../src/session/autoMode.js";

describe("auto mode keeps the card for an MCP write into .git/ (§41.2)", () => {
  it("a filesystem server's write / edit / move / mkdir naming a .git path", () => {
    expect(autoModeKeepsMcpCard({ path: "/repo/.git/hooks/pre-commit", content: "#!/bin/sh\n" })).toBe(true);
    expect(autoModeKeepsMcpCard({ path: "C:\\work\\acme\\.git\\config", edits: [] })).toBe(true);
    expect(autoModeKeepsMcpCard({ source: "/tmp/x.json", destination: "/repo/.git/worktrees/w1/reviewgate/incoming/a.json" })).toBe(true);
    expect(autoModeKeepsMcpCard({ path: "/repo/.git" })).toBe(true);
    expect(autoModeKeepsMcpCard({ paths: ["/repo/a.txt", "/repo/.git/HEAD"] })).toBe(true);
    expect(autoModeDecides("mcp__filesystem__write_file", "auto", "auto", { path: "/repo/.git/hooks/post-checkout", content: "x" })).toBe(false);
  });

  it("not .gitignore / .github, nor a .git path only inside the written content; other MCP calls stay with the CLI", () => {
    expect(autoModeKeepsMcpCard({ path: "/repo/.gitignore", content: ".git/\n" })).toBe(false);
    expect(autoModeKeepsMcpCard({ path: "/repo/.github/workflows/ci.yml" })).toBe(false);
    expect(autoModeKeepsMcpCard({ path: "/repo/src/Svc.java", content: "see /repo/.git/config" })).toBe(false);
    expect(autoModeKeepsMcpCard(undefined)).toBe(false);
    expect(autoModeDecides("mcp__filesystem__write_file", "auto", "auto", { path: "/repo/src/Svc.java", content: "x" })).toBe(true);
    expect(autoModeDecides("mcp__filesystem__write_file", "default", "default", { path: "/repo/.git/config" })).toBe(false);
  });
});
