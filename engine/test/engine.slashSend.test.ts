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
});
