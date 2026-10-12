import { describe, expect, it } from "vitest";
import { mentionsPath } from "../src/review/summary.js";
import { reportedFor, reportItems } from "../src/review/why.js";

/**
 * docs/PROTOCOL.md §37.6: a path written with its folders names THAT file. Before, the basename rule of `mentionsPath`
 * (§15) took `acme-api/pom.xml` as a mention of `acme-core/pom.xml` (any `…/pom.xml`), so the §34.8 `why` of a
 * multi-module change got the other module's reason first — "added dependency X" on the module that only bumped Y — and
 * a plan step about one module's file matched the other's.
 */

describe("a qualified path mentions only the file it names (§37.6)", () => {
  it("another folder's file of the same name is not a mention; the file's own path, a sub-path and a bare name are", () => {
    expect(mentionsPath("acme-api/pom.xml: added dependency X", "acme-core/pom.xml")).toBe(false);
    expect(mentionsPath("see api\\src\\Svc.java", "core/src/Svc.java")).toBe(false);
    // The stem rule too: a qualified name without its extension.
    expect(mentionsPath("moved the lookup into acme-api/UserService", "acme-core/src/UserService.java")).toBe(false);
    // A longer name is not a mention of its tail.
    expect(mentionsPath("acme-core/pom.xml: bumped Y", "core/pom.xml")).toBe(false);
    expect(mentionsPath("edit src/a.tsx", "src/a.ts")).toBe(false);
    // Still mentions: the whole path, a trailing sub-path (either separator), the bare basename / stem, an absolute path.
    expect(mentionsPath("acme-core/pom.xml: bumped Y", "acme-core/pom.xml")).toBe(true);
    expect(mentionsPath("src/main/java/com/x/Svc.java changed", "api/src/main/java/com/x/Svc.java")).toBe(true);
    expect(mentionsPath("com\\x\\Svc.java changed", "api/src/main/java/com/x/Svc.java")).toBe(true);
    expect(mentionsPath("pom.xml: bumped Y", "acme-core/pom.xml")).toBe(true);
    expect(mentionsPath("UserService now caches", "acme-core/src/UserService.java")).toBe(true);
    expect(mentionsPath("wrote /Users/me/repo/acme-core/pom.xml", "acme-core/pom.xml")).toBe(true);
    expect(mentionsPath("(`pom.xml`)", "acme-core/pom.xml")).toBe(true);
  });

  it("the why of a multi-module change takes each module's own reason", () => {
    const report = "- `acme-api/pom.xml`: added dependency X\n- `acme-core/pom.xml`: bumped Y";
    expect(reportedFor("acme-core/pom.xml", null, reportItems(report))).toBe("bumped Y");
    expect(reportedFor("acme-api/pom.xml", null, reportItems(report))).toBe("added dependency X");
  });
});
