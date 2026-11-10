import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeSideRepo } from "./helpers/fakeSide.js";
import { removeDir, write } from "./helpers/repo.js";

/**
 * wave3 engine-flow (§36.13 / §36.14): a message that starts with one of the session's slash commands (`/code-review low`,
 * the client's `prRespondCommand`) goes out as that command — the review-summary prefix waits for the next real message,
 * as for `/compact` (§27); otherwise the prefix turns it into plain text and the CLI never runs the command.
 */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

describe("slash commands in send", () => {
  it("a known command keeps the review summary for the next message; text that only starts with '/' gets it as before", async () => {
    const dir = makeSideRepo();
    dirs.push(dir);
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "Change README" });
    h.session().emitSessionInfo({ slashCommands: ["compact", "code-review", "acme-tools:review-reply"], skills: ["graphify"] });
    write(dir, "README.md", "line1\nline2 changed\nline3\n");
    h.session().emitTurnEnd({ toolFiles: [] });
    await h.waitFor((s) => s.gate.phase === "reviewing", "review");
    await h.engine.request({ type: "accept", paths: ["README.md"] });
    await h.settle();
    const summary = h.engine.state.gate.lastReviewSummary!;
    expect(summary).toContain("Accepted: README.md");
    const s = h.session();

    await h.engine.request({ type: "send", text: "/acme-tools:review-reply 512" });
    expect(s.sends.at(-1)!.text).toBe("/acme-tools:review-reply 512");
    expect(h.engine.state.gate.lastReviewSummary).toBe(summary);
    // The command is no instruction for the commit message suggestion.
    expect(h.engine.state.commit.suggestedMessage.startsWith("/acme")).toBe(false);
    s.emitTurnEnd({ toolFiles: [] });
    await h.waitFor((st) => st.gate.canSend, "command turn done");

    await h.engine.request({ type: "send", text: "/Users/me/x.txt looks wrong" });
    expect(s.sends.at(-1)!.text).toBe(`${summary}\n\n/Users/me/x.txt looks wrong`);
    s.emitTurnEnd({ toolFiles: [] });
    await h.waitFor((st) => st.gate.canSend, "plain turn done");
    expect(h.engine.state.gate.lastReviewSummary).toBeNull();
  });

  /** A review round with README.md accepted; returns the harness and the summary the next plain message carries. */
  async function acceptedRound(caps: (h: Harness) => void): Promise<{ h: Harness; summary: string }> {
    const dir = makeSideRepo();
    dirs.push(dir);
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(dir);
    caps(h);
    await h.engine.handle({ type: "send", text: "Change README" });
    write(dir, "README.md", "line1\nline2 changed\nline3\n");
    h.session().emitTurnEnd({ toolFiles: [] });
    await h.waitFor((s) => s.gate.phase === "reviewing", "review");
    await h.engine.request({ type: "accept", paths: ["README.md"] });
    await h.settle();
    const summary = h.engine.state.gate.lastReviewSummary!;
    expect(summary).toContain("Accepted: README.md");
    return { h, summary };
  }

  it("a plugin skill typed by its short name (an alias the CLI lists) goes out as that command; the next plain message carries the summary", async () => {
    const { h, summary } = await acceptedRound((x) => {
      x.session().emit({
        type: "commands_info",
        commands: [{ name: "acme-plugin:release-notes", description: "Write the release notes", argumentHint: "<version>", aliases: ["release-notes"] }],
      });
      x.session().emitSessionInfo({ slashCommands: ["compact", "acme-plugin:release-notes"], skills: ["acme-plugin:release-notes"] });
    });
    const s = h.session();
    await h.engine.request({ type: "send", text: "/release-notes 123" });
    expect(s.sends.at(-1)!.text).toBe("/release-notes 123");
    expect(h.engine.state.gate.lastReviewSummary).toBe(summary);
    s.emitTurnEnd({ toolFiles: [] });
    await h.waitFor((st) => st.gate.canSend, "command turn done");

    await h.engine.request({ type: "send", text: "thanks — what is next?" });
    expect(s.sends.at(-1)!.text).toBe(`${summary}\n\nthanks — what is next?`);
  });

  it("before any command list is known (a fresh worktree, no cache) a /word goes out as a command; a path still gets the summary", async () => {
    const { h, summary } = await acceptedRound(() => undefined);
    const caps = h.engine.state.session.capabilities;
    expect((caps?.slashCommands ?? []).length + (caps?.skills ?? []).length + (caps?.commands ?? []).length).toBe(0);
    const s = h.session();
    await h.engine.request({ type: "send", text: "/foo bar" });
    expect(s.sends.at(-1)!.text).toBe("/foo bar");
    expect(h.engine.state.gate.lastReviewSummary).toBe(summary);
    s.emitTurnEnd({ toolFiles: [] });
    await h.waitFor((st) => st.gate.canSend, "command turn done");

    await h.engine.request({ type: "send", text: "/Users/x/y.txt looks wrong" });
    expect(s.sends.at(-1)!.text).toBe(`${summary}\n\n/Users/x/y.txt looks wrong`);
  });

  it("once the lists are known, a /word that is none of the session's commands or aliases is plain text (it carries the summary)", async () => {
    const { h, summary } = await acceptedRound((x) => {
      x.session().emit({ type: "commands_info", commands: [{ name: "acme-plugin:release-notes", description: "", argumentHint: "", aliases: ["release-notes"] }] });
    });
    const s = h.session();
    await h.engine.request({ type: "send", text: "/nope 1" });
    expect(s.sends.at(-1)!.text).toBe(`${summary}\n\n/nope 1`);
  });
});

/** MARK: r2-skills-side — §33.5 (M20): a slash command's `allowed-tools` go to the session with the message that runs it. */
describe("a slash command's allowed-tools", () => {
  it("the project's command file is read and its list rides on sendUser; a plain message carries none", async () => {
    const dir = makeSideRepo();
    dirs.push(dir);
    write(dir, ".claude/commands/acme-verify.md", "---\ndescription: Verify before a push\nallowed-tools: Bash(./mvnw test:*), Bash(git status:*)\n---\nRun ./mvnw test.\n");
    const h = makeHarness();
    harnesses.push(h);
    await h.hello({ loadUserSettings: false });
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "hi" });
    const s = h.session();
    expect(s.sends.at(-1)!.command).toBeUndefined();
    s.emitSessionInfo({ slashCommands: ["compact", "acme-verify"], skills: [] });
    s.emitTurnEnd({ toolFiles: [] });
    await h.waitFor((st) => st.gate.canSend, "first turn done");
    await h.engine.request({ type: "send", text: "/acme-verify --fast" });
    expect(s.sends.at(-1)!.command).toEqual({ name: "acme-verify", allowedTools: ["Bash(./mvnw test:*)", "Bash(git status:*)"] });
  });
});
