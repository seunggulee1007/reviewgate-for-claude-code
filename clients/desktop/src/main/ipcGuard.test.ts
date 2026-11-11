import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isAppURL, isSafeExternalURL, validateCommand } from "./ipcGuard.js";

/** Every command type the renderer sends with `engineRequest({ type: "…" })` (its tests aside). */
function rendererCommandTypes(): Map<string, string> {
  const root = fileURLToPath(new URL("../renderer/", import.meta.url));
  const found = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        for (const m of readFileSync(path, "utf8").matchAll(/engineRequest(?:<[^>]*>)?\(\s*\{\s*type:\s*"([a-z_]+)"/g)) found.set(m[1]!, e.name);
      }
    }
  };
  walk(root);
  return found;
}

describe("isAppURL", () => {
  const prod = { fileURL: "file:///Applications/ReviewGate.app/Contents/Resources/app.asar/dist/renderer/index.html" };
  const dev = { ...prod, devURL: "http://localhost:5183/" };

  it("allows only the renderer file (any hash / query)", () => {
    expect(isAppURL(prod.fileURL, prod)).toBe(true);
    expect(isAppURL(`${prod.fileURL}#/settings`, prod)).toBe(true);
    expect(isAppURL(`${prod.fileURL}?x=1`, prod)).toBe(true);
    expect(isAppURL("file:///etc/passwd", prod)).toBe(false);
    expect(isAppURL("file:///Applications/ReviewGate.app/Contents/Resources/app.asar/dist/renderer/other.html", prod)).toBe(false);
    expect(isAppURL("https://example.com/", prod)).toBe(false);
    expect(isAppURL("http://localhost:5183/", prod)).toBe(false);
    expect(isAppURL("javascript:alert(1)", prod)).toBe(false);
    expect(isAppURL("not a url", prod)).toBe(false);
  });

  it("allows the dev server origin only when it is configured", () => {
    expect(isAppURL("http://localhost:5183/index.html", dev)).toBe(true);
    expect(isAppURL("http://localhost:5184/", dev)).toBe(false);
    expect(isAppURL("http://evil.localhost:5183/", dev)).toBe(false);
  });

  it("matches Windows file URLs with spaces and Korean folders", () => {
    const win = { fileURL: "file:///C:/Users/%ED%99%8D%20%EA%B8%B8%EB%8F%99/AppData/Local/Programs/ReviewGate/resources/app.asar/dist/renderer/index.html" };
    expect(isAppURL(win.fileURL, win)).toBe(true);
    expect(isAppURL("file:///C:/Users/홍 길동/AppData/Local/Programs/ReviewGate/resources/app.asar/dist/renderer/index.html", win)).toBe(true);
    expect(isAppURL("file://server/share/index.html", win)).toBe(false);
  });
});

describe("isSafeExternalURL / validateCommand", () => {
  it("keeps the existing allowlists", () => {
    expect(isSafeExternalURL("https://github.com")).toBe(true);
    expect(isSafeExternalURL("file:///C:/Windows/System32/calc.exe")).toBe(false);
    expect(validateCommand({ type: "hello" }).ok).toBe(false);
    expect(validateCommand({ type: "send", text: "x" }).ok).toBe(true);
  });

  // MARK: wave1 desktop-review
  it("allows the review-provenance commands (§31: finish_review, keep_review, reject_all{includeExternal})", () => {
    for (const type of ["finish_review", "keep_review"]) expect(validateCommand({ type }).ok).toBe(true);
    expect(validateCommand({ type: "reject_all", includeExternal: true }).ok).toBe(true);
  });

  it("allows the side-question and MCP commands (§21, §22)", () => {
    for (const type of ["side_ask", "side_list", "side_cancel", "side_close", "side_promote_draft", "side_promote", "mcp_status", "mcp_reconnect", "mcp_toggle", "mcp_add", "mcp_remove", "mcp_auth"]) {
      expect(validateCommand({ type }).ok).toBe(true);
    }
    expect(validateCommand({ type: "set_settings", sideModel: "x" }).ok).toBe(false);
  });

  it("allows the §33 permission commands (permission_rules is a read-only query)", () => {
    for (const type of ["permission_response", "forget_allows", "permission_rules"]) {
      expect(validateCommand({ type }).ok).toBe(true);
    }
  });

  it("allows the composer commands (§23–27)", () => {
    for (const type of ["list_files", "attachment_get", "set_model", "rewind", "compact", "interrupt"]) {
      expect(validateCommand({ type }).ok).toBe(true);
    }
  });

  it("allows steer (§50: ↩ while Claude works puts the message into the turn — refused here, it was only ever queued)", () => {
    expect(validateCommand({ type: "steer", text: "Also check the README" }).ok).toBe(true);
    expect(validateCommand({ type: "steer_take_back", messageId: "u1" }).ok).toBe(true); // §50.3
  });

  it("allows what the renderer sends: unaccept (Accept all's Undo) and the live changes of a running turn (§34.6)", () => {
    for (const type of ["unaccept", "live_changes", "live_diff"]) expect(validateCommand({ type }).ok).toBe(true);
  });

  it("allows every command the renderer sends — a type left off the list is refused here, and the renderer's own tests mock this away", () => {
    const types = rendererCommandTypes();
    expect(types.size).toBeGreaterThan(40); // the scan found the renderer's calls
    const refused = [...types].filter(([type]) => !validateCommand({ type }).ok).map(([type, file]) => `${type} (${file})`);
    expect(refused).toEqual([]);
  });

  it("allows the peer message commands (§29)", () => {
    expect(validateCommand({ type: "peer_accept", ids: ["a", "b"] }).ok).toBe(true);
    expect(validateCommand({ type: "peer_dismiss", ids: ["a"] }).ok).toBe(true);
    expect(validateCommand({ type: "peer_set", mode: "off" }).ok).toBe(true);
    expect(validateCommand({ type: "peer_set_anything" }).ok).toBe(false);
  });

  // MARK: wave3 desktop-agents
  it("allows the §36.1 / §36.2 agent commands (agent_report is a read, stop_agent stops one subagent)", () => {
    expect(validateCommand({ type: "agent_report", toolUseId: "toolu_01Ab" }).ok).toBe(true);
    expect(validateCommand({ type: "stop_agent", toolUseId: "toolu_01Ab" }).ok).toBe(true);
    expect(validateCommand({ type: "stop_agents" }).ok).toBe(false);
  });
});
