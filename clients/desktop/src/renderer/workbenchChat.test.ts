import { beforeEach, describe, expect, it } from "vitest";
import type { ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import { holdSwitch, onHeldMessageBack, usePendingSwitch } from "./pendingSwitch";
import type { ComposerChips } from "./composerBridge";
import { handHeldSwitchToWorkbench, heldForWorkbench, suggestWorkbenchChatBranch, workbenchChatBranchFor, workbenchChatRefusal } from "./workbenchChat";

/**
 * docs/PROTOCOL.md §9 "New Chat in a Workbench" (as Core `WorkbenchChatTests` on the Mac): the branch it suggests, where it
 * is offered, and a held message moving to the new workbench's composer — the held switch called off, nothing sent here,
 * nothing lost.
 */

/** 2026-11-23 09:05 UTC. */
const now = new Date(Date.UTC(2026, 10, 23, 9, 5));

function state(o: { project?: boolean; vcs?: "git" | "shadow"; branches?: string[]; workbenches?: (string | null)[] } = {}): ReviewState {
  return {
    project: o.project === false ? null : { root: "/work/acme", path: "/work/acme", name: "acme", branch: "main", ...(o.vcs ? { vcs: o.vcs } : {}) },
    branches: { list: (o.branches ?? ["main"]).map((name) => ({ name, isCurrent: name === "main" })) },
    workbenches: { list: (o.workbenches ?? []).map((branch, i) => ({ path: `/work/wb-${i}`, branch, isMain: false, isCurrent: false })), current: "/work/acme", managedRoot: "" },
  } as unknown as ReviewState;
}

const image = { name: "clipboard.png", mediaType: "image/png", data: "iVBORw0KGgo=" };

describe("New Chat in a Workbench (§9)", () => {
  beforeEach(() => {
    initI18n("en", "win32");
    usePendingSwitch.setState({ pending: null, inflight: false });
  });

  it("suggests wb/<yyMMdd-HHmm>, and the next number when that branch exists", () => {
    expect(suggestWorkbenchChatBranch([], now, true)).toBe("wb/261123-0905");
    expect(suggestWorkbenchChatBranch(["main", "wb/261123-0904"], now, true)).toBe("wb/261123-0905");
    expect(suggestWorkbenchChatBranch(["wb/261123-0905"], now, true)).toBe("wb/261123-0905-2");
    expect(suggestWorkbenchChatBranch(["wb/261123-0905", "wb/261123-0905-2", "wb/261123-0905-3"], now, true)).toBe("wb/261123-0905-4");
    // local time by default — the same shape
    expect(suggestWorkbenchChatBranch([], now)).toMatch(/^wb\/\d{6}-\d{4}$/);
  });

  it("skips the names of this repository's branches and workbenches", () => {
    const local = suggestWorkbenchChatBranch([], now);
    expect(workbenchChatBranchFor(state({ branches: ["main", local] }), now)).toBe(`${local}-2`);
    expect(workbenchChatBranchFor(state({ workbenches: [local, null] }), now)).toBe(`${local}-2`);
  });

  it("needs a project with git (§59 hides it, with the reason)", () => {
    expect(workbenchChatRefusal(state({ project: false }))).toBe("Open a project first (Ctrl+O)");
    expect(workbenchChatRefusal(state())).toBeNull();
    expect(workbenchChatRefusal(state({ vcs: "shadow" }))).toBe("Workbenches need a git repository — this folder is tracked without git");
  });

  it("moves the held messages to the workbench — text and mentions; images back here; nothing sent", () => {
    const back: { text: string; chips?: ComposerChips }[] = [];
    onHeldMessageBack((text, chips) => void back.push({ text, chips }));
    holdSwitch({
      kind: "open",
      id: "s2",
      messages: [
        { text: "first", extras: { mentions: ["src/cart.ts"] }, chips: { mentions: ["src/cart.ts"], mentionDirs: {}, images: [image] } as unknown as ComposerChips },
        { text: "then this" },
      ],
    });
    expect(heldForWorkbench(usePendingSwitch.getState().pending)).toBe("first\n\n@src/cart.ts\n\nthen this");
    expect(handHeldSwitchToWorkbench()).toBe("first\n\n@src/cart.ts\n\nthen this");
    // Called off here: nothing waits for the turn, and only the image comes back to this composer.
    expect(usePendingSwitch.getState().pending).toBeNull();
    expect(back).toEqual([{ text: "", chips: { mentions: [], mentionDirs: {}, images: [image] } }]);
  });

  it("a held new chat is called off with nothing to hand; nothing held changes nothing", () => {
    const back: string[] = [];
    onHeldMessageBack((text) => void back.push(text));
    holdSwitch({ kind: "new" });
    expect(heldForWorkbench(usePendingSwitch.getState().pending)).toBeNull();
    expect(handHeldSwitchToWorkbench()).toBeNull();
    expect(usePendingSwitch.getState().pending).toBeNull();
    expect(handHeldSwitchToWorkbench()).toBeNull();
    expect(back).toEqual([]);
  });
});
