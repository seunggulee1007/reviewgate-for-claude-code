import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkOnDisk, ideTarget, ideaUrl, insideRoot, isIdeUrl, urlPath, vscodeUrl } from "./ideOpen";

const WIN_ROOT = "C:\\Users\\dev\\My Project";

describe("Open in IDE — the URLs (§62)", () => {
  it("VS Code: vscode://file/<abs>:<line>:<col>, Windows backslashes as slashes, spaces and Korean encoded, the drive kept", () => {
    expect(vscodeUrl("C:\\Users\\dev\\My Project\\src\\한글 파일.java", 12, 5)).toBe(
      "vscode://file/C:/Users/dev/My%20Project/src/%ED%95%9C%EA%B8%80%20%ED%8C%8C%EC%9D%BC.java:12:5",
    );
    expect(vscodeUrl("/Users/dev/acme/src/A.kt", 3, 1)).toBe("vscode://file/Users/dev/acme/src/A.kt:3:1");
    expect(vscodeUrl("/work/acme/a#b?c%d.js", 1, 1)).toBe("vscode://file/work/acme/a%23b%3Fc%25d.js:1:1");
  });

  it("IntelliJ IDEA: idea://open?file=<abs>&line=<line>, the whole path one encoded parameter", () => {
    expect(ideaUrl("C:\\Users\\dev\\My Project\\Cart&Co.java", 40)).toBe("idea://open?file=C%3A%2FUsers%2Fdev%2FMy%20Project%2FCart%26Co.java&line=40");
    expect(ideaUrl("/work/acme/A.java", 1)).toBe("idea://open?file=%2Fwork%2Facme%2FA.java&line=1");
  });

  it("puts a line / column that is no positive whole number at 1", () => {
    expect(vscodeUrl("/w/a.js", 0, -3)).toBe("vscode://file/w/a.js:1:1");
    expect(ideaUrl("/w/a.js", 1.5)).toBe("idea://open?file=%2Fw%2Fa.js&line=1");
    expect(urlPath("D:\\x y")).toBe("/D:/x%20y");
  });
});

describe("Open in IDE — main's checks (§62)", () => {
  it("joins the project root and the repo-relative path (Windows and POSIX roots)", () => {
    expect(insideRoot(WIN_ROOT, "src/main/한글.java")).toBe("C:\\Users\\dev\\My Project\\src\\main\\한글.java");
    expect(insideRoot("/work/acme", "src/A.java")).toBe("/work/acme/src/A.java");
  });

  it("refuses anything that is not a plain path inside the project", () => {
    for (const bad of ["../secret.txt", "src/../../x", "/etc/passwd", "C:\\Windows\\x.exe", "C:/Windows/x.exe", "src\\..\\x", "a\0b", "a\nb", "", "src//x", 42, null]) {
      expect(insideRoot(WIN_ROOT, bad), String(bad)).toBeNull();
      expect(insideRoot("/work/acme", bad), String(bad)).toBeNull();
    }
    expect(insideRoot("relative/root", "a.js")).toBeNull();
  });

  it("builds only the two schemes or the file, from the IDE's name — never a URL from the renderer", () => {
    expect(ideTarget("/work/acme", "vscode", "src/A.java", 7, 3)).toEqual({ kind: "url", url: "vscode://file/work/acme/src/A.java:7:3", absolutePath: "/work/acme/src/A.java" });
    expect(ideTarget("/work/acme", "idea", "src/A.java", 7, 3)).toEqual({ kind: "url", url: "idea://open?file=%2Fwork%2Facme%2Fsrc%2FA.java&line=7", absolutePath: "/work/acme/src/A.java" });
    expect(ideTarget(WIN_ROOT, "system", "src/A.java", 7, 3)).toEqual({ kind: "path", absolutePath: "C:\\Users\\dev\\My Project\\src\\A.java" });
    expect(ideTarget("/work/acme", "https://example.com", "src/A.java", 1, 1)).toEqual({ refused: "bad_request" });
    expect(ideTarget("/work/acme", "explorer", "src/A.java", 1, 1)).toEqual({ refused: "bad_request" });
    expect(ideTarget(null, "vscode", "src/A.java", 1, 1)).toEqual({ refused: "no_project" });
    expect(ideTarget("/work/acme", "vscode", "vscode://file/etc/passwd", 1, 1)).toEqual({ refused: "outside_project" });
    for (const url of ["vscode://file/work/acme/src/A.java:7:3", "idea://open?file=%2Fa&line=1"]) expect(isIdeUrl(url)).toBe(true);
    for (const url of ["https://example.com", "file:///C:/x.exe", "vscode://extension/x", "idea://other"]) expect(isIdeUrl(url)).toBe(false);
  });

  const dir = mkdtempSync(join(tmpdir(), "rg-ide-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("on disk: a regular file inside the project's real path; a folder, a missing file or a symlink out is refused", () => {
    const root = join(dir, "proj");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "A.java"), "class A {}\n");
    writeFileSync(join(dir, "outside.txt"), "x");
    symlinkSync(join(dir, "outside.txt"), join(root, "link.txt"));
    expect(checkOnDisk(root, join(root, "src", "A.java"))).toBeNull();
    expect(checkOnDisk(root, join(root, "src"))).toBe("not_a_file");
    expect(checkOnDisk(root, join(root, "missing.java"))).toBe("not_a_file");
    expect(checkOnDisk(root, join(root, "link.txt"))).toBe("outside_project");
  });
});
