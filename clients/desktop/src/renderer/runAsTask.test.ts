/**
 * docs/PROTOCOL.md §49 "Run as Task" on the desktop client — the cases of the Mac's Core `RunAsTaskTests` (the branch the
 * sheet suggests, the prefix the next one starts with), what the composer hands over, the setting's default and the
 * refusals in Korean. The store's side (`workbench_create {task}`, `task_started`) is in flowStore.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_TASK_TEXT } from "@reviewgate/engine";
import { EngineRefusal, refusalOf } from "./engineRequest";
import { flowRefusal } from "./flowLogic";
import { initI18n } from "./i18n";
import { composerTaskText, DEFAULT_TASK_PREFIX, runAsTaskEnabled, suggestTaskBranch, taskBranchPrefixOf, taskPrefixOf } from "./runAsTask";

describe("the branch Run as Task suggests (TaskBranchName.suggest)", () => {
  const at = new Date(1_800_000_000 * 1000); // 2027-01-15 08:00 UTC

  it("takes a link's last path number", () => {
    expect(suggestTaskBranch("이 업무 진행해줘 https://acme.example.com/project/tasks/3901234567", undefined, at)).toBe("task/3901234567");
    expect(suggestTaskBranch("see https://github.com/acme/app/issues/42 please", "fix/")).toBe("fix/42");
    expect(suggestTaskBranch("https://tasks.example.com/acme/77.")).toBe("task/77"); // the sentence's period is not the link's
  });

  it("takes a key", () => {
    expect(suggestTaskBranch("#shop/1234 장바구니 합계 오류")).toBe("task/shop-1234");
    expect(suggestTaskBranch("ABC-123: cart total is wrong")).toBe("task/ABC-123");
    expect(suggestTaskBranch("issue #77 again")).toBe("task/77");
  });

  it("else up to five ASCII words of the first line, URLs without a number skipped", () => {
    expect(suggestTaskBranch("Add discount codes to the cart page today\nmore", "feature/")).toBe("feature/add-discount-codes-to-the");
    expect(suggestTaskBranch("  \nFix README typo")).toBe("task/fix-readme-typo");
    expect(suggestTaskBranch("Open https://tasks.example.com/board now")).toBe("task/open-now");
  });

  it("else the date and time", () => {
    expect(suggestTaskBranch("장바구니 합계가 틀려요", undefined, at, true)).toBe("task/20270115-0800");
    expect(suggestTaskBranch("", "", at, true)).toBe("20270115-0800");
  });

  it("starts with the prefix the last task branch used, cleaned so the name stays valid", () => {
    expect(taskBranchPrefixOf("feature/acme/42")).toBe("feature/acme/");
    expect(taskBranchPrefixOf("hotfix-42")).toBe("");
    expect(taskBranchPrefixOf("  task/9 ")).toBe("task/");
    // A prefix that would make the name invalid is cleaned: odd characters out, `..` and `.lock` parts dropped.
    expect(suggestTaskBranch("ABC-1", "bad prefix:/")).toBe("badprefix/ABC-1");
    expect(suggestTaskBranch("ABC-1", "../x.lock/")).toBe("ABC-1");
  });
});

describe("what the composer hands over (ChatComposer.taskText)", () => {
  it("the draft, then its @ mentions as @path", () => {
    expect(composerTaskText("  Fix the cart \n", [])).toBe("Fix the cart");
    expect(composerTaskText("Fix the cart", ["api/Cart.java", "web/"])).toBe("Fix the cart\n\n@api/Cart.java @web/");
    expect(composerTaskText("  ", ["api/Cart.java"])).toBe("@api/Cart.java");
    expect(composerTaskText("", [])).toBe("");
  });
});

describe("the setting (runAsTaskEnabled / taskBranchPrefix)", () => {
  it("is on unless turned off; the prefix is task/ until a task branch was created", () => {
    expect(runAsTaskEnabled(null)).toBe(true);
    expect(runAsTaskEnabled({})).toBe(true);
    expect(runAsTaskEnabled({ runAsTaskEnabled: false })).toBe(false);
    expect(taskPrefixOf(undefined)).toBe(DEFAULT_TASK_PREFIX);
    expect(taskPrefixOf({ taskBranchPrefix: "" })).toBe("");
    expect(taskPrefixOf({ taskBranchPrefix: "feature/acme/" })).toBe("feature/acme/");
  });
});

describe("the refusals of workbench_create {task} in Korean", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  it("says what to do", () => {
    expect(MAX_TASK_TEXT).toBe(100_000);
    expect(flowRefusal(new EngineRefusal("invalid_task", "invalid_task"))).toBe("먼저 업무 내용을 적어 주세요 (최대 100,000자).");
    expect(flowRefusal(new EngineRefusal("task_handoff_failed:EACCES: permission denied", "task_handoff_failed"))).toBe("워크벤치는 만들었지만 업무를 넘기지 못했어요: EACCES: permission denied");
    expect(refusalOf(new Error("task_handoff_failed:disk full")).code).toBe("task_handoff_failed");
  });
});
