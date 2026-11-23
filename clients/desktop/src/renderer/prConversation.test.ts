/**
 * §60 the PR's Conversation on Windows: the description, the general comments and the reviews as one time-ordered
 * thread (PENDING left out, an empty-body review still marks its state), and the PR detail opening on it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EngineCommand, PRDetail, PRIssueComment, PRReview, ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import { prTimeline, reviewStateBadge } from "./prConversation";

// The app's Markdown renderer needs a DOM (DOMPurify): here it only shows which text went through it.
vi.mock("./components/chat/Markdown", () => ({ Markdown: ({ text }: { text: string }) => createElement("div", { className: "markdown" }, text) }));

const detail = (p: Partial<PRDetail> = {}): PRDetail => ({
  number: 7,
  title: "Add the widget",
  body: "This adds **the widget**.",
  author: "octo",
  state: "OPEN",
  url: "https://github.com/acme/app/pull/7",
  headRefName: "feat/widget",
  baseRefName: "main",
  headRefOid: "abc",
  reviewDecision: "",
  additions: 3,
  deletions: 1,
  changedFiles: 1,
  ...p,
});

const comment = (id: number, createdAt: string, p: Partial<PRIssueComment> = {}): PRIssueComment => ({
  id,
  author: "alice",
  body: `comment ${id}`,
  createdAt,
  updatedAt: createdAt,
  url: `https://github.com/acme/app/pull/7#issuecomment-${id}`,
  ...p,
});

const review = (id: number, state: string, submittedAt: string | null, p: Partial<PRReview> = {}): PRReview => ({
  id,
  author: "bob",
  state,
  body: "",
  submittedAt,
  url: submittedAt ? `https://github.com/acme/app/pull/7#pullrequestreview-${id}` : null,
  ...p,
});

describe("prTimeline (§60)", () => {
  it("puts the description first, then comments and reviews merged by time", () => {
    const items = prTimeline(
      detail(),
      [comment(1, "2026-11-01T10:00:00Z"), comment(2, "2026-11-01T12:00:00Z")],
      [review(10, "COMMENTED", "2026-11-01T11:00:00Z", { body: "looks fine" }), review(11, "APPROVED", "2026-11-01T13:00:00Z")],
    );
    expect(items.map((i) => i.key)).toEqual(["description", "c1", "r10", "c2", "r11"]);
    expect(items[0]).toMatchObject({ kind: "description", author: "octo", body: "This adds **the widget**.", url: "https://github.com/acme/app/pull/7" });
  });

  it("leaves a PENDING review out and keeps a review whose body is empty", () => {
    const items = prTimeline(detail(), [], [review(20, "PENDING", null, { body: "draft" }), review(21, "CHANGES_REQUESTED", "2026-11-02T09:00:00Z")]);
    expect(items.map((i) => i.key)).toEqual(["description", "r21"]);
    expect(items[1]).toMatchObject({ kind: "review", state: "CHANGES_REQUESTED", body: "" });
  });

  it("marks an edited comment", () => {
    const items = prTimeline(detail(), [comment(1, "2026-11-01T10:00:00Z", { updatedAt: "2026-11-01T10:05:00Z" }), comment(2, "2026-11-01T11:00:00Z", { updatedAt: null })], []);
    expect(items[1]).toMatchObject({ kind: "comment", edited: true });
    expect(items[2]).toMatchObject({ kind: "comment", edited: false });
  });

  it("names the review states", () => {
    expect(reviewStateBadge("APPROVED")).toEqual({ label: "Approved", color: "green" });
    expect(reviewStateBadge("CHANGES_REQUESTED")).toEqual({ label: "Changes requested", color: "red" });
    expect(reviewStateBadge("COMMENTED").label).toBe("Commented");
  });
});

async function loadStore() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: () => undefined,
      request: async () => ({}),
      requestDetailed: async (_c: EngineCommand) => ({ ok: true, reply: { type: "result", ok: true } }),
      setSettings: async (patch: Record<string, unknown>) => patch,
      getSettings: async () => ({}),
      setUI: async () => undefined,
      notify: async () => true,
      onEvent: () => () => undefined,
      openExternal: async () => undefined,
      platform: "win32",
      sep: "\\",
    },
  };
  return (await import("./store")).useStore;
}
type UseStore = Awaited<ReturnType<typeof loadStore>>;

describe("the PR detail's Conversation (§60, Windows)", () => {
  beforeAll(() => initI18n("ko", "win32"));
  afterAll(() => initI18n("en", "darwin"));

  let useStore: UseStore;
  let seq = 9000;
  beforeEach(async () => {
    useStore = await loadStore();
  });

  const show = (pr: Partial<ReviewState["pr"]>) => {
    const s = useStore.getState().state;
    useStore.setState({ tab: "prs", state: { ...s, seq: ++seq, pr: { ...s.pr, selected: detail(), files: [], comments: [], reviews: [], conversation: [], draftComments: [], ...pr } } as ReviewState });
  };
  const render = async () => {
    Object.assign(useStore.getInitialState(), useStore.getState());
    const { PRDetail } = await import("./components/pr/PRDetail");
    return renderToStaticMarkup(createElement(PRDetail));
  };

  it("opens on the Conversation: the description, then the thread with state badges, times and GitHub links", async () => {
    show({
      conversation: [comment(1, "2026-11-01T10:00:00Z", { body: "Can you add a *test*?" })],
      reviews: [review(10, "APPROVED", "2026-11-01T11:00:00Z"), review(11, "PENDING", null, { body: "my draft" })],
    });
    const html = await render();
    expect(html).toContain('data-testid="PR conversation"');
    expect(html).not.toContain('data-testid="PR diff pane"');
    expect(html).toMatch(/aria-selected="true"[^>]*data-testid="PR view conversation"/);
    expect(html).toContain("대화");
    // the description first, as Markdown
    const order = ["PR entry description", "PR entry c1", "PR entry r10"].map((id) => html.indexOf(`data-testid="${id}"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('<div class="markdown">This adds **the widget**.</div>');
    expect(html).toContain('<div class="markdown">Can you add a *test*?</div>');
    // the review with no body still says it approved; the pending one is not there
    expect(html).toContain("승인됨");
    expect(html).not.toContain("my draft");
    // a time with its absolute form in the tooltip, and "Open on GitHub" on each entry
    expect(html).toMatch(/<time[^>]*dateTime="2026-11-01T10:00:00Z"[^>]*title="[^"]+"/);
    expect(html.split('data-testid="Open entry on GitHub"').length - 1).toBe(3);
    expect(html).toContain("GitHub에서 열기");
  });

  it("says so when the PR has no description", async () => {
    show({ selected: detail({ body: "" }) });
    const html = await render();
    expect(html).toContain("본문이 없어요.");
  });
});
