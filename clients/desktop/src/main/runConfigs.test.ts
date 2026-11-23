/**
 * MARK: c-panel — §57.18: the Run tab's candidates come from the project's files only (nothing runs), the list keeps the
 * saved commands first and hides removed detected ones, settingsGuard accepts only well-formed entries, and main runs
 * only a kept command — a detected one once confirmed.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { folderFiles } from "./runFiles.js";
import { sanitizeSettingsPatch } from "./settingsGuard.js";
import { detectRunCandidates, isProjectRuns, keepRun, listedRuns, removeRun, restoreDetected, runnableCommand, storedRuns, type RunConfig } from "../shared/runConfigs.js";

function commands(files: Record<string, string>, platform: NodeJS.Platform = "win32"): string[] {
  const root = mkdtempSync(join(tmpdir(), "rg-runs-"));
  try {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), text);
    }
    return detectRunCandidates(folderFiles(root), platform).map((c) => c.command);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("run candidates (§57.18)", () => {
  it("package.json scripts in their order, with the package manager", () => {
    const json = JSON.stringify({ name: "acme-web", scripts: { build: "vite build", lint: "eslint .", test: "vitest", dev: "vite", start: "node ." } });
    expect(commands({ "package.json": json })).toEqual(["npm run dev", "npm start", "npm test", "npm run build"]);
    const two = JSON.stringify({ scripts: { dev: "vite", test: "vitest" } });
    expect(commands({ "package.json": two, "pnpm-lock.yaml": "" })).toEqual(["pnpm run dev", "pnpm test"]);
    expect(commands({ "package.json": two, "yarn.lock": "" })).toEqual(["yarn dev", "yarn test"]);
    expect(commands({ "package.json": two, "bun.lockb": "" })).toEqual(["bun run dev", "bun run test"]);
    expect(commands({ "package.json": JSON.stringify({ packageManager: "pnpm@9.1.0", scripts: { serve: "x" } }), "yarn.lock": "" })).toEqual(["pnpm run serve"]);
    expect(commands({ "package.json": "{ not json" })).toEqual([]);
    expect(commands({ "package.json": JSON.stringify({ scripts: { dev: 42 } }) })).toEqual([]);
  });

  it("the Gradle wrapper: bootRun with Spring Boot, run with the application plugin, test — .bat on Windows", () => {
    const groovy = "plugins {\n  id 'org.springframework.boot' version '3.3.0'\n  id 'application'\n}";
    expect(commands({ "gradlew.bat": "", "build.gradle": groovy })).toEqual([".\\gradlew.bat bootRun", ".\\gradlew.bat run", ".\\gradlew.bat test"]);
    expect(commands({ gradlew: "", "build.gradle.kts": 'plugins { id("org.springframework.boot") }' }, "darwin")).toEqual(["./gradlew bootRun", "./gradlew test"]);
    expect(commands({ "gradlew.bat": "", "build.gradle.kts": "plugins { `application` }" })).toEqual([".\\gradlew.bat run", ".\\gradlew.bat test"]);
    expect(commands({ "gradlew.bat": "", "settings.gradle": "rootProject.name = 'acme'" })).toEqual([".\\gradlew.bat test"]);
    expect(commands({ gradlew: "", "build.gradle": "" })).toEqual([]); // the POSIX wrapper only: not on Windows
    expect(commands({ "build.gradle": "id 'org.springframework.boot'" })).toEqual([]);
  });

  it("the Maven wrapper: spring-boot:run with Spring Boot, test", () => {
    const pom = "<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>";
    expect(commands({ "mvnw.cmd": "", "pom.xml": pom })).toEqual([".\\mvnw.cmd spring-boot:run", ".\\mvnw.cmd test"]);
    expect(commands({ mvnw: "", "pom.xml": "<project/>" }, "darwin")).toEqual(["./mvnw test"]);
    expect(commands({ "pom.xml": pom })).toEqual([]);
  });
});

const dev: RunConfig = { id: "npm:dev", name: "npm: dev", command: "npm run dev", detected: true, confirmed: false };
const test: RunConfig = { id: "npm:test", name: "npm: test", command: "npm test", detected: true, confirmed: false };

describe("the kept runs (§57.18)", () => {
  it("lists kept commands first and hides removed detected ones until Find Again", () => {
    let runs = keepRun(undefined, { ...dev, confirmed: true });
    runs = keepRun(runs, { id: "u1", name: "Seed", command: "make seed", detected: false, confirmed: true });
    expect(listedRuns(runs, [dev, test]).map((c) => c.command)).toEqual(["npm run dev", "make seed", "npm test"]);
    expect(listedRuns(runs, [dev, test])[0]!.confirmed).toBe(true);
    runs = removeRun(runs, test);
    expect(listedRuns(runs, [dev, test]).map((c) => c.command)).toEqual(["npm run dev", "make seed"]);
    runs = restoreDetected(runs);
    expect(listedRuns(runs, [dev, test]).map((c) => c.command)).toEqual(["npm run dev", "make seed", "npm test"]);
    expect(storedRuns({ configs: [], dismissed: [] })).toBeNull();
  });

  it("main runs only a kept command, a detected one once confirmed", () => {
    expect(runnableCommand({ configs: [dev], dismissed: [] }, "npm:dev")).toBeNull();
    expect(runnableCommand({ configs: [{ ...dev, confirmed: true }], dismissed: [] }, "npm:dev")).toBe("npm run dev");
    expect(runnableCommand({ configs: [{ id: "u1", name: "x", command: "make", detected: false, confirmed: false }], dismissed: [] }, "u1")).toBe("make");
    expect(runnableCommand(undefined, "npm:dev")).toBeNull();
    expect(runnableCommand({ configs: [dev], dismissed: [] }, 3)).toBeNull();
  });

  it("settings accept only well-formed entries keyed by a project hash", () => {
    const good = { configs: [{ ...dev, confirmed: true }], dismissed: ["npm test"] };
    expect(isProjectRuns(good)).toBe(true);
    expect(isProjectRuns({ configs: [{ ...dev, command: "a\nb" }], dismissed: [] })).toBe(false);
    expect(isProjectRuns({ configs: [{ ...dev, extra: 1 }], dismissed: [] })).toBe(false);
    expect(isProjectRuns({ configs: [], dismissed: [""] })).toBe(false);
    expect(sanitizeSettingsPatch({ projectRunConfigs: { "0a1b2c3d": good } }).rejected).toEqual([]);
    expect(sanitizeSettingsPatch({ projectRunConfigs: { "not-a-hash": good } }).rejected).toEqual(["projectRunConfigs"]);
  });
});
