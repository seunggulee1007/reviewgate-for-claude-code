import { describe, expect, it } from "vitest";
import type { PermissionRulesEvent } from "@reviewgate/engine";
import { rulesAfterFetch } from "./terminalRules";

// wave2 check-clients — Settings › Permissions › terminal allow rules, as on the Mac (c9d1bd7): a refused reload says why
// above the rules read last time instead of hiding them; a successful one replaces them.

const rules = (n: number): PermissionRulesEvent =>
  ({ type: "permission_rules", sources: [], rules: Array.from({ length: n }, (_, i) => ({ rule: `WebFetch(domain:h${i})`, source: "user", status: "applied", why: "non_mutating_tool", importAs: null })), defaultMode: null, defaultModeSupported: false, applyUserAllowRules: true, loadUserSettings: true }) as PermissionRulesEvent;

describe("terminal allow rules — reload", () => {
  it("a refusal keeps the last rules and shows the reason", () => {
    const shown = { loading: true, rules: rules(2), error: null };
    expect(rulesAfterFetch(shown, { ok: false, message: "세션이 없습니다" })).toEqual({ loading: false, rules: rules(2), error: "세션이 없습니다" });
  });

  it("a reply replaces them and clears an earlier error; the first refusal has nothing to keep", () => {
    expect(rulesAfterFetch({ loading: true, rules: rules(2), error: "x" }, { ok: true, rules: rules(3) })).toEqual({ loading: false, rules: rules(3), error: null });
    expect(rulesAfterFetch({ loading: true, rules: null, error: null }, { ok: false, message: "m" })).toEqual({ loading: false, rules: null, error: "m" });
  });
});
