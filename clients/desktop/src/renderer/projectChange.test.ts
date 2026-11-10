// MARK: polish p-lifecycle — P1-chrome-03: switching or closing the window's project asks main first (§55.7).
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_QUEUE } from "./sendQueue";
import { confirmProjectChange, isOpenProject } from "./projectChange";

type Facts = Parameters<typeof confirmProjectChange>[0];
const facts = (queued: number): Facts =>
  ({
    state: { project: { root: "/work/acme-api" }, sessions: { currentId: "c1" } },
    queue: { ...EMPTY_QUEUE, items: Array.from({ length: queued }, (_, i) => ({ id: i, text: `m${i}` })) },
    side: { threads: [] },
    flow: { create: null },
  }) as unknown as Facts;

describe("P1-chrome-03: a project switch or close asks first", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("hands main what only the page knows and returns its answer", async () => {
    const confirm = vi.fn(async () => ({ asked: true, ok: false }));
    vi.stubGlobal("window", { rg: { confirmProjectChange: confirm } });
    expect(await confirmProjectChange(facts(2), "switch")).toEqual({ asked: true, ok: false });
    expect(confirm).toHaveBeenCalledWith("switch", expect.objectContaining({ queued: 2 }));
  });

  it("goes ahead when there is no bridge or it fails", async () => {
    vi.stubGlobal("window", { rg: {} });
    expect(await confirmProjectChange(facts(0), "close")).toEqual({ asked: false, ok: true });
    vi.stubGlobal("window", { rg: { confirmProjectChange: async () => Promise.reject(new Error("gone")) } });
    expect(await confirmProjectChange(facts(0), "close")).toEqual({ asked: false, ok: true });
  });

  it("knows the project already open (its folder or root; Windows without case)", () => {
    const project = { path: "/work/acme-api/app", root: "/work/acme-api" };
    expect(isOpenProject(project, "/work/acme-api/", "darwin")).toBe(true);
    expect(isOpenProject(project, "/work/acme-api/app", "darwin")).toBe(true);
    expect(isOpenProject(project, "/work/acme-web", "darwin")).toBe(false);
    expect(isOpenProject(null, "/work/acme-api", "darwin")).toBe(false);
    expect(isOpenProject({ path: "C:\\Work\\Acme", root: "C:\\Work\\Acme" }, "c:/work/acme/", "win32")).toBe(true);
    expect(isOpenProject({ path: "/Work/Acme", root: "/Work/Acme" }, "/work/acme", "darwin")).toBe(false);
  });
});
