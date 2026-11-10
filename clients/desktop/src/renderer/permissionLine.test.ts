import { describe, expect, it } from "vitest";
import type { PermissionRequest } from "@reviewgate/engine";
import { permissionLineStatus, permissionLineText } from "./permissionLine";

// MARK: r2-review-flow — M27, as on the Mac (Core ReviewFlowPermissionLineTests.swift).

describe("a permission card in the transcript is one line (M27)", () => {
  const req = (toolName: string, input: Record<string, unknown>, file?: string): PermissionRequest => ({ requestId: "r1", toolName, input, ...(file ? { file } : {}) }) as PermissionRequest;
  it("says the answer and the call", () => {
    const bash = req("Bash", { command: "git commit -m \"fix cart total\"\ngit push" });
    expect(permissionLineText(bash, true, false)).toBe("Allowed · Bash git commit -m \"fix cart total\" …");
    expect(permissionLineText(bash, false, false)).toBe("Denied · Bash git commit -m \"fix cart total\" …");
    expect(permissionLineText(bash, null, false)).toBe("Handled · Bash git commit -m \"fix cart total\" …");
    expect(permissionLineText(bash, null, true)).toBe("Waiting for your answer below · Bash git commit -m \"fix cart total\" …");
    expect(permissionLineText(req("Write", { file_path: "/work/acme/.env" }, "/work/acme/.env"), true, false)).toBe("Allowed · Write /work/acme/.env");
    expect(permissionLineStatus({ toolName: "SendMessage" }, true, false)).toBe("sent");
    expect(permissionLineStatus({ toolName: "SendMessage" }, false, false)).toBe("notSent");
  });
});
