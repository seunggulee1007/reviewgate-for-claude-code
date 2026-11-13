import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpJson, EMPTY_MCP_JSON, isMcpConfigPath, mcpConfigMtime } from "./mcpConfigFile";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "mcpcfg-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("mcp config file guard", () => {
  it("takes only an absolute .mcp.json / .claude.json", () => {
    const d = tmp();
    expect(isMcpConfigPath(join(d, ".mcp.json"))).toBe(true);
    expect(isMcpConfigPath(join(d, ".claude.json"))).toBe(true);
    expect(isMcpConfigPath(join(d, "settings.json"))).toBe(false);
    expect(isMcpConfigPath(".mcp.json")).toBe(false);
    expect(isMcpConfigPath(`${join(d, ".mcp.json")}\n--x`)).toBe(false);
    expect(isMcpConfigPath(42)).toBe(false);
  });

  it("creates an empty .mcp.json once and never overwrites", () => {
    const f = join(tmp(), ".mcp.json");
    expect(mcpConfigMtime(f)).toBeNull();
    expect(createMcpJson(f)).toBe("created");
    expect(readFileSync(f, "utf8")).toBe(EMPTY_MCP_JSON);
    writeFileSync(f, '{"mcpServers": {"a": {}}}');
    expect(createMcpJson(f)).toBe("exists");
    expect(readFileSync(f, "utf8")).toContain('"a"');
    expect(createMcpJson(join(tmp(), ".claude.json"))).toBe("failed");
    expect(createMcpJson(join(tmp(), "missing", ".mcp.json"))).toBe("failed");
  });

  it("sees a save by the modification time", () => {
    const f = join(tmp(), ".mcp.json");
    writeFileSync(f, "{}");
    const before = mcpConfigMtime(f);
    utimesSync(f, new Date(), new Date(Date.now() + 60_000));
    expect(mcpConfigMtime(f)).not.toBe(before);
  });
});
