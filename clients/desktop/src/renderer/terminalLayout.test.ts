/** §57.5 / plan §4.3: a terminal chat's review panel beside the terminal, or a drawer over it (the Mac's PaneSplit). */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_SHARE,
  REVIEW_FLOOR,
  reviewDrawerWidth,
  reviewHidesSidebar,
  reviewPanelWidth,
  reviewWidthForShare,
  terminalMinWidth,
  terminalReviewLayout,
  terminalShareOf,
  terminalWidth,
} from "./terminalLayout";

const CELL = 7.8; // Cascadia Mono 13 px
const MIN = terminalMinWidth(CELL); // 80 columns + scrollbar + padding
/** The terminal + review area in a window `w` px wide: the sidebar (300 + its divider) and the 26 px edge tab aside. */
const area = (w: number, sidebar: boolean) => w - (sidebar ? 301 : 0) - 26;

describe("80 columns, never fewer", () => {
  it("80 columns of a 7.8 px cell plus the chrome", () => {
    expect(MIN).toBe(646);
    expect(terminalMinWidth(9)).toBe(742);
  });

  it("side by side only where 80 columns, the 360 px floor and the divider fit", () => {
    expect(terminalReviewLayout(MIN + REVIEW_FLOOR + 1, MIN)).toBe("side");
    expect(terminalReviewLayout(MIN + REVIEW_FLOOR, MIN)).toBe("drawer");
  });

  it("at the reference window widths", () => {
    expect(terminalReviewLayout(area(1000, true), MIN)).toBe("drawer");
    expect(terminalReviewLayout(area(1000, false), MIN)).toBe("drawer");
    expect(terminalReviewLayout(area(1280, true), MIN)).toBe("drawer");
    expect(terminalReviewLayout(area(1280, false), MIN)).toBe("side");
    expect(terminalReviewLayout(area(1440, true), MIN)).toBe("side");
    expect(terminalReviewLayout(area(1440, false), MIN)).toBe("side");
  });

  it("the divider moves between the floor and 80 columns of terminal", () => {
    const total = area(1440, true); // 1113
    expect(terminalWidth(600, total, MIN)).toBe(MIN);
    expect(terminalWidth(700, total, MIN)).toBe(700);
    expect(terminalWidth(1000, total, MIN)).toBe(total - REVIEW_FLOOR);
    expect(reviewPanelWidth(400, total, MIN)).toBe(400);
    expect(reviewPanelWidth(100, total, MIN)).toBe(REVIEW_FLOOR);
    expect(reviewPanelWidth(900, total, MIN)).toBe(total - MIN);
    for (let t = MIN + REVIEW_FLOOR + 1; t <= 2400; t += 7) {
      for (const want of [0, 0.3 * t, 0.7 * t, t]) {
        const panel = reviewPanelWidth(want, t, MIN);
        expect(t - panel).toBeGreaterThanOrEqual(MIN);
        expect(panel).toBeGreaterThanOrEqual(REVIEW_FLOOR);
      }
    }
    expect(terminalWidth(300, 200, MIN)).toBe(200);
  });
});

describe("the remembered split", () => {
  it("the terminal takes 55 % until the divider moves", () => {
    expect(DEFAULT_TERMINAL_SHARE).toBe(0.55);
    const total = area(1280, false); // 1254
    expect(reviewWidthForShare(undefined, total, MIN)).toBe(Math.round(total * 0.45));
    expect(reviewWidthForShare(Number.NaN, total, MIN)).toBe(Math.round(total * 0.45));
    expect(reviewWidthForShare(2, total, MIN)).toBe(Math.round(total * 0.45));
  });

  it("a share that would squeeze the terminal below 80 columns gives way", () => {
    const total = area(1440, true); // 1113: 55 % is 612 px, under 80 columns
    expect(reviewWidthForShare(0.55, total, MIN)).toBe(total - MIN);
    expect(reviewWidthForShare(0.95, total, MIN)).toBe(REVIEW_FLOOR);
  });

  it("the share a drag leaves", () => {
    expect(terminalShareOf(450, 1000)).toBe(0.55);
    expect(terminalShareOf(990, 1000)).toBe(0.05);
    expect(terminalShareOf(0, 1000)).toBe(0.95);
    expect(terminalShareOf(100, 0)).toBe(DEFAULT_TERMINAL_SHARE);
  });
});

describe("the drawer", () => {
  it("45 % of the area, at least the floor, a strip of terminal left", () => {
    expect(reviewDrawerWidth(area(1000, true))).toBe(360);
    expect(reviewDrawerWidth(area(1000, false))).toBe(Math.round(974 * 0.45));
    expect(reviewDrawerWidth(area(1280, true))).toBe(Math.round(953 * 0.45));
    expect(reviewDrawerWidth(934)).toBe(420);
  });

  it("the floor wins over the strip; a tiny area gives what is there", () => {
    expect(reviewDrawerWidth(450)).toBe(360);
    expect(reviewDrawerWidth(300)).toBe(300);
    expect(reviewDrawerWidth(0)).toBe(0);
  });
});

describe("the file list steps aside for the review panel", () => {
  const hides = (a: number, hidden = false) => reviewHidesSidebar(a, 301, hidden, MIN);
  it("only where beside it the panel would be a drawer", () => {
    // 1000 px: a drawer with or without the file list — hidden, the drawer is 45 % of the wider area.
    expect(hides(area(1000, true))).toBe(true);
    expect(hides(area(1000, false), true)).toBe(true);
    expect(terminalReviewLayout(area(1000, false), MIN)).toBe("drawer");
    expect(reviewDrawerWidth(area(1000, false))).toBe(Math.round(974 * 0.45));
    // 1280 px: hidden, it fits side by side.
    expect(hides(area(1280, true))).toBe(true);
    expect(terminalReviewLayout(area(1280, false), MIN)).toBe("side");
    // 1440 px: it fits beside the file list — the file list stays, and comes back once the window is that wide.
    expect(hides(area(1440, true))).toBe(false);
    expect(hides(area(1440, false), true)).toBe(false);
  });
});
