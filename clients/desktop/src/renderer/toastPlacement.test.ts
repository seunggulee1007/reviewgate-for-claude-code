import { describe, expect, it } from "vitest";
import { toastPlacement } from "./toast";

// wave2 check-clients — the window's toast sat at the window's bottom centre (bottom: 28px), on top of the composer's hint
// row and next to its buttons, and off the chat column when the sidebar or the diff pane is open. It now floats at the
// bottom of the transcript (above the HUD strip, the cards and the composer), centred on the chat column.

describe("toast placement", () => {
  it("sits 12px above the bottom of the transcript, centred on it", () => {
    // 1360×900 window: sidebar 0–327, transcript 327–1360 from y 34 to 735.
    expect(toastPlacement({ left: 327, width: 1033, bottom: 735 }, 900)).toEqual({ left: 843.5, bottom: 177, maxWidth: 560 });
    // A narrow chat column at the window's right edge: the toast stays inside it (not past the window's edge).
    expect(toastPlacement({ left: 940, width: 420, bottom: 735 }, 900)).toEqual({ left: 1150, bottom: 177, maxWidth: 396 });
  });

  it("no transcript on screen (PR tab, no project): the default place (null)", () => {
    expect(toastPlacement(null, 900)).toBeNull();
    // A transcript squeezed to nothing is no anchor either.
    expect(toastPlacement({ left: 0, width: 0, bottom: 0 }, 900)).toBeNull();
  });
});
