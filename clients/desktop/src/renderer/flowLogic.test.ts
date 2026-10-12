/**
 * MARK: wave3 desktop-flow — the commit template preview (§36.11), the New Workbench sheet's base / sibling folder / steps
 * (§36.12) and the flow refusals, with the Mac's rules (WorkflowToolsTests) and the §36 examples.
 */
import { describe, expect, it } from "vitest";
import type { WorkbenchProgressEvent } from "@reviewgate/engine";
import { EngineRefusal } from "./engineRequest";
import { t } from "./i18n";
import {
  applyProgress,
  commitIssue,
  createdPathOf,
  defaultWorkbenchBase,
  flowRefusal,
  flowRefusalText,
  formatBytes,
  isUnknownCommand,
  latestLog,
  preReviewFailure,
  renderCommitTemplate,
  setupFailedOf,
  setupReportOf,
  shownSteps,
  siblingWorkbenchPath,
  stepExit,
  stepState,
  updateReason,
} from "./flowLogic";

const ev = (step: WorkbenchProgressEvent["step"], extra: Partial<WorkbenchProgressEvent> = {}): WorkbenchProgressEvent => ({
  type: "workbench_progress",
  path: "/Users/me/acme-4790",
  branch: "feature/acme/4790",
  step,
  ...extra,
});

describe("§36.11 commit template", () => {
  it("{issue} is the branch name's longest digit run since §41.1, {branch} the branch", () => {
    expect(commitIssue("feature/acme/4747")).toBe("4747");
    expect(commitIssue("hotfix/2.1.3-fix12")).toBe("12");
    expect(commitIssue("feature/acme/4821-17")).toBe("4821");
    expect(commitIssue("main")).toBe("");
    expect(commitIssue(null)).toBe("");
    expect(renderCommitTemplate("#acme/{issue}: [{branch}]", "feature/acme/4747")).toBe("#acme/4747: [feature/acme/4747]");
    expect(renderCommitTemplate("#acme/{issue}: {issue}", null)).toBe("#acme/: ");
  });
});

describe("§36.12 the New Workbench sheet", () => {
  it("starts from the remote twin of the main worktree's branch when fetching is the default", () => {
    const remotes = ["upstream/develop", "origin/develop", "origin/feature/acme/4747", "origin/main"];
    expect(defaultWorkbenchBase("feature/acme/4747", "develop", remotes, true, true)).toBe("origin/develop");
    expect(defaultWorkbenchBase("feature/acme/4747", null, remotes, true, true)).toBe("origin/feature/acme/4747");
    expect(defaultWorkbenchBase("local-only", "release", remotes, true, true)).toBe("local-only");
    expect(defaultWorkbenchBase("feature/acme/4747", "develop", remotes, false, true)).toBe("feature/acme/4747");
    expect(defaultWorkbenchBase("feature/acme/4747", "develop", remotes, true, false)).toBe("feature/acme/4747");
    // "acme/4747" is not a twin of "origin/feature/acme/4747"
    expect(defaultWorkbenchBase("acme/4747", null, remotes, true, true)).toBe("acme/4747");
    expect(defaultWorkbenchBase("develop", null, ["upstream/develop"], true, true)).toBe("upstream/develop");
  });

  it("the sibling folder: <parent>/<repo>-<branch tail>", () => {
    expect(siblingWorkbenchPath("/Users/me/acme", "feature/acme/4790")).toBe("/Users/me/acme-4790");
    expect(siblingWorkbenchPath("/Users/me/acme/", "fix x")).toBe("/Users/me/acme-fix-x");
    expect(siblingWorkbenchPath("C:\\work\\acme", "feature/acme/4790")).toBe("C:\\work\\acme-4790");
  });

  it("one entry per step, in order — the latest event wins", () => {
    let p: WorkbenchProgressEvent[] = [];
    p = applyProgress(p, ev("create"));
    p = applyProgress(p, ev("fetch", { exitCode: 0 }));
    p = applyProgress(p, ev("setup", { logTail: "[ERROR] BUILD FAILURE\n", exitCode: 1 }));
    expect(p.map((x) => x.step)).toEqual(["fetch", "create", "setup"]);
    expect(setupFailedOf(p)).toBe(true);
    expect(createdPathOf(p)).toBe("/Users/me/acme-4790");
    expect(latestLog(p)).toBe("[ERROR] BUILD FAILURE");
    expect(setupReportOf(p)).toEqual({ branch: "feature/acme/4790", exitCode: 1, log: "[ERROR] BUILD FAILURE" });
    p = applyProgress(p, ev("setup", { logTail: "[INFO] BUILD SUCCESS\n", exitCode: 0 }));
    expect(p).toHaveLength(3);
    expect(setupFailedOf(p)).toBe(false);
    expect(setupReportOf(p)).toBeNull();
  });

  it("a setup killed at 10 minutes is a failure without a code; `done` repeats the setup's exit", () => {
    expect(stepExit(ev("setup", { exitCode: null }))).toEqual({ kind: "killed" });
    expect(stepExit(ev("setup"))).toEqual({ kind: "none" });
    const p = [ev("create"), ev("done", { exitCode: null })];
    expect(setupFailedOf(p)).toBe(true);
    expect(setupReportOf(p)?.exitCode).toBeNull();
  });

  it("the steps drawn: what happened, and while running what is still ahead", () => {
    expect(shownSteps([], true)).toEqual(["create"]);
    expect(shownSteps([], false)).toEqual([]);
    const p = [ev("fetch", { exitCode: 0 }), ev("create")];
    expect(shownSteps(p, true)).toEqual(["fetch", "create", "copy", "setup", "done"]);
    expect(shownSteps([...p, ev("done")], false)).toEqual(["fetch", "create", "done"]);
    expect(stepState(p, "create", true)).toBe("running");
    expect(stepState(p, "fetch", true)).toBe("done");
    expect(stepState(p, "setup", true)).toBe("pending");
    // a failed fetch only warns (the create goes on from the local ref); a failed setup is an error
    expect(stepState([ev("fetch", { exitCode: 128 })], "fetch", true)).toBe("warning");
    expect(stepState([ev("setup", { exitCode: 2 })], "setup", false)).toBe("failed");
  });

  it("sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(12_300)).toBe("12.3 KB");
    expect(formatBytes(4_200_000)).toBe("4.2 MB");
  });
});

describe("flow refusals in words", () => {
  it("the flow codes; anything else falls back to the app's words", () => {
    expect(flowRefusalText("nothing_to_commit", "")).toBe("Select accepted files first — only accepted files can be committed");
    expect(flowRefusalText("commit_draft_failed", "the fork answered nothing")).toBe("Claude could not write a message: the fork answered nothing");
    expect(flowRefusalText("fetch_failed", "fatal: couldn't find remote ref")).toBe("Could not fetch from the remote: fatal: couldn't find remote ref");
    expect(flowRefusalText("whatever", "")).toBeNull();
    expect(flowRefusal(new EngineRefusal("side_limit", "side_limit"))).toBe("Too many side sessions are running — wait for one to finish");
    expect(flowRefusal(new EngineRefusal("no_project", "no_project"))).toBe(t("Open a project first (⌘O)"));
  });

  it("an engine before §36 refuses unknown_command: the control says to update", () => {
    const old = new EngineRefusal("unknown command: commit_draft", "unknown_command");
    expect(isUnknownCommand(old)).toBe(true);
    expect(isUnknownCommand(new Error("unknown command: prereview_start"))).toBe(true);
    expect(isUnknownCommand(new EngineRefusal("side_limit", "side_limit"))).toBe(false);
    expect(flowRefusal(old)).toBe(updateReason());
  });

  it("a failed pre-review's error", () => {
    expect(preReviewFailure(undefined)).toBe("The pre-review failed");
    expect(preReviewFailure("side_limit")).toBe("Too many side sessions are running — wait for one to finish");
    expect(preReviewFailure("the CLI exited with 1")).toBe("the CLI exited with 1");
    expect(preReviewFailure("interrupted (ReviewGate was closed)")).toBe("Interrupted — ReviewGate was closed or the chat changed");
  });
});
