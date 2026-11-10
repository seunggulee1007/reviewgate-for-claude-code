import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { USER_SKIPPED_MESSAGE } from "../src/session/claude.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeRepo, removeDir } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §33.10 (r2-chats-cards M25): `permission_response {allow: false}` without a message leaves the deny's
 * words to the session (the terminal's "No"); `skip: true` says "go on without it"; `interrupt: true` ("멈추기") reaches
 * the session as an interrupting deny. The answer leaves the queue and gets its row as any other.
 */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

async function withCard(requestId: string): Promise<Harness> {
  const dir = realpathSync(makeRepo());
  dirs.push(dir);
  const h = makeHarness();
  harnesses.push(h);
  await h.hello();
  await h.open(dir);
  await h.engine.handle({ type: "send", text: "clean the build and publish" });
  h.session().emit({ type: "permission_request", requestId, toolName: "Bash", input: { command: "git push --force" }, toolUseId: `tu-${requestId}` });
  await h.settle();
  return h;
}

describe("deny like the terminal's No (§33.10)", () => {
  it("a plain deny sends no message — the session says the CLI's No", async () => {
    const h = await withCard("D1");
    await h.engine.handle({ type: "permission_response", requestId: "D1", allow: false });
    expect(h.session().permissionResponses).toEqual([{ requestId: "D1", allow: false, message: undefined }]);
    expect(h.engine.state.session.pendingPermissions).toEqual([]);
  });

  it("건너뛰고 계속 (`skip`): Claude is told to go on without the call", async () => {
    const h = await withCard("S1");
    await h.engine.handle({ type: "permission_response", requestId: "S1", allow: false, skip: true });
    expect(h.session().permissionResponses).toEqual([{ requestId: "S1", allow: false, message: USER_SKIPPED_MESSAGE }]);
  });

  it("the user's own words win over `skip`", async () => {
    const h = await withCard("S2");
    await h.engine.handle({ type: "permission_response", requestId: "S2", allow: false, skip: true, message: "push to a branch instead" });
    expect(h.session().permissionResponses).toEqual([{ requestId: "S2", allow: false, message: "push to a branch instead" }]);
  });

  it("멈추기 (`interrupt`): an interrupting deny; an allow never interrupts", async () => {
    const h = await withCard("I1");
    await h.engine.handle({ type: "permission_response", requestId: "I1", allow: false, interrupt: true });
    expect(h.session().permissionResponses).toEqual([{ requestId: "I1", allow: false, message: undefined, interrupt: true }]);
    expect(h.engine.state.session.pendingPermissions).toEqual([]);

    h.session().emit({ type: "permission_request", requestId: "I2", toolName: "Bash", input: { command: "make" }, toolUseId: "tu-I2" });
    await h.settle();
    await h.engine.handle({ type: "permission_response", requestId: "I2", allow: true, interrupt: true });
    expect(h.session().permissionResponses.at(-1)).toEqual({ requestId: "I2", allow: true, message: undefined });
  });
});
