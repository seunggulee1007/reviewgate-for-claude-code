/**
 * MARK: wave2 desktop-diff — the unified rows as they render (react-dom/server, no window): audit comp-18's DOM cost of a
 * 20 000-line diff, generated-file folds, §34.7 segments / wsOnly, and the context expander rows.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DiffHunk, DiffLine, FileDiff } from "@reviewgate/engine";
import { LARGE_DIFF_LINES } from "../diffFold";
import { UnifiedDiff, type DiffContextSource } from "./UnifiedDiff";

/** `sizes[i]` added lines per hunk (each hunk with its header row, as the engine's parser emits it). */
function bigDiff(sizes: number[]): FileDiff {
  let id = 0;
  let no = 1;
  const hunks: DiffHunk[] = sizes.map((n, h) => {
    const header = `@@ -${no},0 +${no},${n} @@`;
    const lines: DiffLine[] = [{ id: id++, kind: "hunkHeader", oldNo: null, newNo: null, text: header }];
    for (let i = 0; i < n; i++) lines.push({ id: id++, kind: "add", oldNo: null, newNo: no, text: `    "dependency-${no++}": "1.0.0",` });
    return { id: h, header, lines };
  });
  return { oldPath: "package-lock.json", newPath: "package-lock.json", isBinary: false, hunks };
}

const render = (props: Parameters<typeof UnifiedDiff>[0]) => renderToStaticMarkup(createElement(UnifiedDiff, props));
/** Code rows (`.line`) and fold rows in the markup. */
const count = (html: string) => ({ lines: (html.match(/class="line /g) ?? []).length, folds: (html.match(/class="diff-fold"/g) ?? []).length });

describe("DOM cost of a 20 000-line diff (audit comp-18)", () => {
  it("a new 20 000-line file draws its first rows and one fold — not 20 001 rows", () => {
    const html = render({ diff: bigDiff([20_000]) });
    const c = count(html);
    expect(c.lines).toBe(LARGE_DIFF_LINES);
    expect(c.folds).toBe(1);
    expect(html).toContain("Large diff · 17001 lines · Expand");
    // what the browser has to build stays bounded (the whole diff used to be ~20k rows / several MB of markup)
    expect(html.length).toBeLessThan(1_200_000);
  });

  it("20 000 lines over 100 hunks: whole hunks up to the limit, then one header row + one fold per hunk", () => {
    const c = count(render({ diff: bigDiff(Array.from({ length: 100 }, () => 200)) }));
    // 14 hunks of 201 rows fit (2814); the 15th shows its first 186 rows; 85 hunks stay as header + fold
    expect(c.lines).toBe(14 * 201 + 186 + 85);
    expect(c.folds).toBe(86);
    expect(c.lines + c.folds).toBeLessThan(LARGE_DIFF_LINES + 2 * 100);
  });

  it("a lockfile (§34.7 generated) is one fold row whatever its size", () => {
    const html = render({ diff: bigDiff([20_000]), generated: "lockfile" });
    expect(count(html)).toEqual({ lines: 0, folds: 1 });
    expect(html).toContain("Generated file · +20000 lines · Expand");
  });

  it("a diff under the limit is drawn whole, as before (an engine without `generated` included)", () => {
    expect(count(render({ diff: bigDiff([1000, 999]) }))).toEqual({ lines: 2001, folds: 0 });
  });

  it("a line with a note or a side thread is never folded away", () => {
    // the note sits on new line 3 of a lockfile: the generated fold opens
    expect(count(render({ diff: bigDiff([5]), generated: "lockfile", highlighted: new Set(["new:3"]) })).folds).toBe(0);
    // a side thread on the 40th line of the 90th hunk of a large diff: that hunk is drawn down to it
    const diff = bigDiff(Array.from({ length: 100 }, () => 200));
    const line = diff.hunks[89]!.lines[40]!;
    const html = render({ diff, anchoredLines: new Set([`new:${line.newNo}`]) });
    expect(html).toContain(`data-id="${line.id}"`);
    expect(count(html).folds).toBe(86);
  });
});

describe("line detail (§34.7)", () => {
  const pair: FileDiff = {
    oldPath: "Svc.java",
    newPath: "Svc.java",
    isBinary: false,
    hunks: [
      {
        id: 0,
        header: "@@ -12,2 +12,2 @@",
        lines: [
          { id: 0, kind: "hunkHeader", oldNo: null, newNo: null, text: "@@ -12,2 +12,2 @@" },
          { id: 1, kind: "del", oldNo: 12, newNo: null, text: "return repo.find(id).orElseThrow();", segments: [[21, 34]] },
          { id: 2, kind: "add", oldNo: null, newNo: 12, text: "return repo.find(id).orElseThrow(NotFound::new);", segments: [[21, 47]] },
          { id: 3, kind: "del", oldNo: 13, newNo: null, text: "  int  b = 2;", wsOnly: true, segments: [[0, 2]] },
          { id: 4, kind: "add", oldNo: null, newNo: 13, text: "\tint b = 2;", wsOnly: true, segments: [[0, 1]] },
        ],
      },
    ],
  };

  it("changed parts are marked inside the line; the rest of the line is plain text", () => {
    const html = render({ diff: pair });
    expect(html).toContain('<span class="text">return repo.find(id).<span class="seg">orElseThrow()</span>;</span>');
    expect(html).toContain('<span class="seg">orElseThrow(NotFound::new)</span>');
  });

  it("a whitespace-only pair is dimmed and says so; without segments a line renders exactly as before", () => {
    const html = render({ diff: pair });
    expect(html).toMatch(/class="line del ws-only"[^>]*title="Only whitespace changed"/);
    const plain = render({ diff: { ...pair, hunks: [{ ...pair.hunks[0]!, lines: pair.hunks[0]!.lines.map(({ segments: _s, wsOnly: _w, ...l }) => l) }] } });
    expect(plain).toContain('<span class="text">return repo.find(id).orElseThrow();</span>');
    expect(plain).not.toContain("seg");
  });

  it("wraps long lines by default (the preference, no window)", () => {
    expect(render({ diff: pair })).toContain('class="unified scroll wrap"');
  });
});

describe("20줄 더 보기", () => {
  const diff: FileDiff = {
    oldPath: "A.java",
    newPath: "A.java",
    isBinary: false,
    hunks: [
      {
        id: 0,
        header: "@@ -40,7 +40,7 @@",
        lines: [
          { id: 0, kind: "hunkHeader", oldNo: null, newNo: null, text: "@@ -40,7 +40,7 @@" },
          ...[40, 41, 42].map((n, i): DiffLine => ({ id: 1 + i, kind: "context", oldNo: n, newNo: n, text: `l${n}` })),
          { id: 4, kind: "del", oldNo: 43, newNo: null, text: "old" },
          { id: 5, kind: "add", oldNo: null, newNo: 43, text: "l43" },
          ...[44, 45, 46].map((n, i): DiffLine => ({ id: 6 + i, kind: "context", oldNo: n, newNo: n, text: `l${n}` })),
        ],
      },
    ],
  };
  const source = (lines: string[] | null): DiffContextSource => ({ lines, loading: false, unavailable: null, load: () => undefined });

  it("offers more lines above the first hunk and below the last one; nothing without a context source", () => {
    const html = render({ diff, context: source(null) });
    expect(html).toContain('data-testid="Expand context 0 up"');
    expect(html).toContain('data-testid="Expand context 1 down"');
    expect(render({ diff })).not.toContain("Expand context");
  });

  it("a file that is not the diff's new side (edited on disk since) disables the expanders with the reason, once", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `l${i + 1}`);
    lines[41] = "edited in the IDE";
    const html = render({ diff, context: source(lines) });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="Expand context 0 up"/);
    expect((html.match(/The file changed on disk after this diff/g) ?? []).length).toBe(3); // 2 tooltips + 1 visible line
  });
});
