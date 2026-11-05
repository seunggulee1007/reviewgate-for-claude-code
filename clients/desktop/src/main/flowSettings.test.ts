/**
 * MARK: wave3 desktop-flow — §36.11 / §36.12 / §36.14 settings: kept per repository (its main worktree, so every workbench
 * shares them), checked when the renderer writes them, and given to the window's engine as explicit values whenever the
 * repository it shows or the settings change (never twice the same).
 */
import { describe, expect, it } from "vitest";
import type { Settings } from "@reviewgate/engine";
import { projectRootHash } from "../shared/hash.js";
import {
  DEFAULT_WORKBENCH_SETUP,
  commitTemplateFor,
  flowEngineSettings,
  flowRepoRoot,
  isWorkbenchSetup,
  preReviewEffortOf,
  prRespondCommandFor,
  sameWorkbenchSetup,
  withRepoEntry,
  workbenchSetupFor,
  workbenchSetupOf,
} from "../shared/flowSettings.js";
import { resyncFlowSettings, syncFlowSettings } from "./flowSync.js";
import { sanitizeSettingsPatch } from "./settingsGuard.js";
import { validateCommand } from "./ipcGuard.js";

const h = projectRootHash;
const project = (path: string) => ({ path, root: path });

describe("flow settings belong to the repository (§36.11 / §36.12 / §36.14)", () => {
  it("the repository is the main worktree; without a workbench list, the open folder", () => {
    expect(flowRepoRoot(null)).toBeNull();
    expect(flowRepoRoot({ project: null })).toBeNull();
    expect(flowRepoRoot({ project: project("/repo") })).toBe("/repo");
    const workbench = {
      project: project("/w/acme-4790"),
      workbenches: { list: [{ path: "/repo", isMain: true }, { path: "/w/acme-4790", isMain: false }] },
    };
    expect(flowRepoRoot(workbench)).toBe("/repo");
  });

  it("reads each repository's own values, defaults filled in", () => {
    const s = {
      projectCommitTemplate: { [h("/repo")]: "#acme/{issue}: " },
      projectWorkbenchSetup: { [h("/repo")]: { copy: ["mvnw", " .mvn/** ", ""], setupCommand: " ./mvnw -q compile ", location: "sibling" as const } },
      projectPrRespondCommand: { [h("/repo")]: "  /acme-tools:review-reply {pr}  " },
    };
    expect(commitTemplateFor(s, "/repo")).toBe("#acme/{issue}: ");
    expect(commitTemplateFor(s, "/other")).toBe("");
    expect(commitTemplateFor(s, null)).toBe("");
    expect(workbenchSetupFor(s, "/repo")).toEqual({ copy: ["mvnw", ".mvn/**"], useWorktreeInclude: true, setupCommand: "./mvnw -q compile", fetchBase: true, location: "sibling" });
    expect(workbenchSetupFor(s, "/other")).toEqual(DEFAULT_WORKBENCH_SETUP);
    expect(prRespondCommandFor(s, "/repo")).toBe("/acme-tools:review-reply {pr}");
    expect(prRespondCommandFor(undefined, "/repo")).toBe("");
    expect(preReviewEffortOf({})).toBe("medium");
    expect(preReviewEffortOf({ preReviewEffort: "high" })).toBe("high");
  });

  it("an empty value removes the repository's entry; another repository's stays", () => {
    const map = withRepoEntry({ [h("/a")]: "x" }, "/b", "y");
    expect(map).toEqual({ [h("/a")]: "x", [h("/b")]: "y" });
    expect(withRepoEntry(map, "/a", null)).toEqual({ [h("/b")]: "y" });
    expect(sameWorkbenchSetup({ fetchBase: true }, undefined)).toBe(true);
    expect(sameWorkbenchSetup({ fetchBase: false }, undefined)).toBe(false);
    expect(workbenchSetupOf({ location: "elsewhere" as never }).location).toBe("managed");
  });

  it("the engine gets explicit values for the window's repository (a template-less one clears the previous)", () => {
    expect(flowEngineSettings({}, null)).toBeNull();
    expect(flowEngineSettings({ projectCommitTemplate: { [h("/repo")]: "T" } }, "/other")).toEqual({ commitTemplate: "", workbenchSetup: DEFAULT_WORKBENCH_SETUP });
  });
});

describe("main sends them only when they change", () => {
  const sink = () => {
    const sent: Partial<Settings>[] = [];
    return { sent, handle: (cmd: { type: "set_settings"; settings: Partial<Settings> }) => void sent.push(cmd.settings) };
  };
  const settings = { projectCommitTemplate: { [h("/repo")]: "#acme/{issue}: " } };

  it("on the project's first snapshot, again only for another repository or other values", () => {
    const engine = sink();
    expect(syncFlowSettings(engine, { project: null }, settings)).toBe(false);
    expect(syncFlowSettings(engine, { project: project("/repo") }, settings)).toBe(true);
    expect(engine.sent).toEqual([{ commitTemplate: "#acme/{issue}: ", workbenchSetup: DEFAULT_WORKBENCH_SETUP }]);
    expect(syncFlowSettings(engine, { project: project("/repo") }, settings)).toBe(false);
    // a workbench of the same repository: the same values, nothing sent
    const wb = { project: project("/w/x"), workbenches: { list: [{ path: "/repo", isMain: true }] } };
    expect(syncFlowSettings(engine, wb, settings)).toBe(false);
    expect(syncFlowSettings(engine, { project: project("/other") }, settings)).toBe(true);
    expect(engine.sent.at(-1)).toEqual({ commitTemplate: "", workbenchSetup: DEFAULT_WORKBENCH_SETUP });
  });

  it("an edit reaches the engine of the repository it shows — and only that one", () => {
    const repo = sink();
    const other = sink();
    syncFlowSettings(repo, { project: project("/repo") }, {});
    syncFlowSettings(other, { project: project("/other") }, {});
    expect(resyncFlowSettings(repo, settings)).toBe(true);
    expect(repo.sent.at(-1)?.commitTemplate).toBe("#acme/{issue}: ");
    expect(resyncFlowSettings(other, settings)).toBe(false);
    expect(resyncFlowSettings(sink(), settings)).toBe(false); // an engine without a project
  });
});

describe("the renderer may write them — checked", () => {
  it("templates, setups and PR commands per repository hash; the effort", () => {
    const patch = {
      projectCommitTemplate: { [h("/repo")]: "#acme/{issue}: [주문] …\n\n- …" },
      projectWorkbenchSetup: { [h("/repo")]: { copy: ["mvnw", ".mvn/**"], useWorktreeInclude: false, setupCommand: "./mvnw -q -o compile", fetchBase: true, location: "sibling" } },
      projectPrRespondCommand: { [h("/repo")]: "/acme-tools:review-reply {pr}" },
      preReviewEffort: "high",
    };
    const r = sanitizeSettingsPatch(patch);
    expect(r.rejected).toEqual([]);
    expect(r.patch).toEqual(patch);
  });

  it("drops anything else", () => {
    const r = sanitizeSettingsPatch({
      projectCommitTemplate: { "not-a-hash": "x" },
      projectWorkbenchSetup: { [h("/repo")]: { copy: ["a\nb"] } },
      projectPrRespondCommand: { [h("/repo")]: "/x\n/y" },
      preReviewEffort: "max",
    });
    expect(r.patch).toEqual({});
    expect(r.rejected.sort()).toEqual(["preReviewEffort", "projectCommitTemplate", "projectPrRespondCommand", "projectWorkbenchSetup"]);
    expect(isWorkbenchSetup({ setupCommand: "x", extra: 1 })).toBe(false);
    expect(isWorkbenchSetup({ location: "sibling", fetchBase: "yes" })).toBe(false);
    expect(isWorkbenchSetup({ copy: Array.from({ length: 201 }, () => "a") })).toBe(false);
    expect(isWorkbenchSetup({ setupCommand: "a\0b" })).toBe(false);
    expect(isWorkbenchSetup({})).toBe(true);
  });
});

describe("the flow commands pass main's guard", () => {
  it("commit_draft, workbench_preview, prereview_start / cancel / dismiss", () => {
    for (const type of ["commit_draft", "workbench_preview", "prereview_start", "prereview_cancel", "prereview_dismiss"]) {
      expect(validateCommand({ type }).ok).toBe(true);
    }
  });

  it("§53 commit_hunks, commit_split_draft, commit_series (the commit sheet's split mode)", () => {
    for (const type of ["commit_hunks", "commit_split_draft"]) expect(validateCommand({ type, paths: ["a.ts"] }).ok).toBe(true);
    expect(validateCommand({ type: "commit_series", commits: [{ message: "m", parts: [{ path: "a.ts", hunks: [0] }] }], push: false }).ok).toBe(true);
  });

  it("§51 pr_ai_draft (the PR sheet's Fill with Claude)", () => {
    expect(validateCommand({ type: "pr_ai_draft", base: "develop", title: "#acme/42: 재고 동기화" })).toEqual({ ok: true, cmd: { type: "pr_ai_draft", base: "develop", title: "#acme/42: 재고 동기화" } });
  });
});
