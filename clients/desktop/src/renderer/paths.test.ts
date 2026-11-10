import { describe, expect, it } from "vitest";
import { relativeToRoot } from "./paths";

describe("relativeToRoot", () => {
  it("POSIX roots: exact prefix by component, case-sensitive", () => {
    expect(relativeToRoot("/Users/x/repo/src/a.ts", "/Users/x/repo")).toBe("src/a.ts");
    expect(relativeToRoot("/Users/x/repo/src/a.ts", "/Users/x/repo/")).toBe("src/a.ts");
    expect(relativeToRoot("/Users/x/repo-other/a.ts", "/Users/x/repo")).toBeNull();
    expect(relativeToRoot("/users/x/repo/a.ts", "/Users/x/repo")).toBeNull();
    expect(relativeToRoot("/Users/x/repo", "/Users/x/repo")).toBeNull();
    expect(relativeToRoot("/a", null)).toBeNull();
  });

  it("Windows roots (native, from the engine): either separator, any case, POSIX result", () => {
    const root = "C:\\Users\\x\\Repo";
    expect(relativeToRoot("C:\\Users\\x\\Repo\\src\\a.ts", root)).toBe("src/a.ts");
    expect(relativeToRoot("c:/users/x/repo/src/A.ts", root)).toBe("src/A.ts");
    expect(relativeToRoot("C:\\Users\\x\\Repo2\\a.ts", root)).toBeNull();
    expect(relativeToRoot("D:\\Users\\x\\Repo\\a.ts", root)).toBeNull();
    expect(relativeToRoot("\\\\srv\\share\\repo\\a.ts", "\\\\SRV\\share\\repo")).toBe("a.ts");
  });
});
