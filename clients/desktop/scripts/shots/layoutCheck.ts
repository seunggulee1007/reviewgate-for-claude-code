/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * The screenshot harness's layout check (the Mac tour's CUT / OUT OF THE WINDOW / OVERLAP / BLANK / HOME PATH): run in the
 * page after a scene's steps (scripts/shots/main.ts passes `layoutCheck.toString()` to `executeJavaScript`, so this function
 * must stay self-contained — no imports, no outer names). Any finding marks the shot and fails the run.
 *
 * - CLIPPED   a non-scrolling box (`overflow: hidden | clip`) or a button whose content is wider / taller than it, unless
 *             it ends on purpose (`text-overflow: ellipsis` across, `-webkit-line-clamp` down);
 * - CUT       a control or a line of text partly hidden by such a box (some of it shows, not all; an ellipsis excuses
 *             only the width);
 * - WRAPPED   a short word with no space in it (a count, a key, a label) broken over two lines;
 * - SIDEWAYS  a control or a line of text past the right edge of the scrolling box it is in (a list or a chat scrolling
 *             sideways because a row does not fit); code (pre, .mono, a diff's lines) may scroll sideways;
 * - OUTSIDE   a control or a line of text past the window's edge with no scrolling box around it;
 * - OVERLAP   two controls on top of each other (both reachable: neither covered by a dialog, neither inside the other);
 * - NO REASON a control that is off with no tooltip saying why (its own title, or its radio group's / label's);
 * - BLANK     no text on the page (the PNG's own one-colour check is in main.ts);
 * - HOME      the real home folder's path in any text, title, label, placeholder or value.
 */
export type LayoutFinding = { kind: "CLIPPED" | "CUT" | "WRAPPED" | "SIDEWAYS" | "OUTSIDE" | "OVERLAP" | "NO REASON" | "BLANK" | "HOME"; what: string; rect: { x: number; y: number; w: number; h: number } | null };

export function layoutCheck(opts: { home: string }): LayoutFinding[] {
  const out: LayoutFinding[] = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const SKIP = ".monaco-editor, .xterm, script, style, svg, noscript, template, [data-shots-ignore]";
  const describe = (el: Element): string => {
    const id = el.closest("[data-testid]")?.getAttribute("data-testid");
    const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 48);
    return `${el.tagName.toLowerCase()}${cls}${id ? ` in [${id}]` : ""}${text ? ` "${text}"` : ""}`;
  };
  const rectOf = (r: DOMRect) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
  const shown = (el: Element): boolean => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1; // a 1 px box is text for screen readers only (.sr-only)
  };
  const clips = (cs: CSSStyleDeclaration) => /hidden|clip/.test(cs.overflowX) || /hidden|clip/.test(cs.overflowY);
  const scrolls = (cs: CSSStyleDeclaration) => /auto|scroll/.test(cs.overflowX) || /auto|scroll/.test(cs.overflowY);
  // An ellipsis says "cut on purpose" across; a line clamp says it down.
  const ellipsis = (cs: CSSStyleDeclaration) => cs.textOverflow === "ellipsis";
  const clamped = (cs: CSSStyleDeclaration) => cs.getPropertyValue("-webkit-line-clamp") !== "none" && cs.getPropertyValue("-webkit-line-clamp") !== "";
  const hasOwnText = (el: Element) => [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
  const isControl = (el: Element) => el.matches("button, [role=button], [role=tab], [role=option], a[href], input:not([type=hidden]), select, textarea");

  const all = [...document.body.querySelectorAll("*")].filter((el) => !el.closest(SKIP) && shown(el));

  for (const el of all) {
    const cs = getComputedStyle(el);
    const h = el as HTMLElement;
    // CLIPPED: the box hides part of its own content and does not say so.
    if (clips(cs) && !scrolls(cs) && !el.matches("input, textarea, select, img, canvas, video")) {
      const wide = /hidden|clip/.test(cs.overflowX) && !ellipsis(cs) && h.scrollWidth > h.clientWidth + 1;
      const tall = /hidden|clip/.test(cs.overflowY) && !clamped(cs) && h.scrollHeight > h.clientHeight + 1;
      if ((wide || tall) && hasOwnText(el)) out.push({ kind: "CLIPPED", what: `${describe(el)} (${wide ? `${h.scrollWidth} > ${h.clientWidth} wide` : `${h.scrollHeight} > ${h.clientHeight} tall`})`, rect: rectOf(el.getBoundingClientRect()) });
    }
    if (!isControl(el) && !hasOwnText(el)) continue;
    // A button's content larger than the button: Chromium clips it at the button's edge whatever `overflow` says.
    if (el.matches("button") && ((!ellipsis(cs) && h.scrollWidth > h.clientWidth + 1) || h.scrollHeight > h.clientHeight + 1)) {
      out.push({ kind: "CLIPPED", what: `${describe(el)} (content ${h.scrollWidth}×${h.scrollHeight} in ${h.clientWidth}×${h.clientHeight})`, rect: rectOf(el.getBoundingClientRect()) });
    }
    // WRAPPED: a short word (a count, a key, a label without spaces) broken over two lines.
    for (const n of el.childNodes) {
      const word = (n.textContent ?? "").trim();
      if (n.nodeType !== Node.TEXT_NODE || word.length < 2 || word.length > 16 || /\s/.test(word)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const tops = new Set([...range.getClientRects()].filter((q) => q.width > 0).map((q) => Math.round(q.top)));
      if (tops.size > 1) out.push({ kind: "WRAPPED", what: `${describe(el)} ("${word}" on ${tops.size} lines)`, rect: rectOf(el.getBoundingClientRect()) });
    }
    // What of it shows: its box cut by the non-scrolling clipping ancestors (a button clips like `overflow: hidden`) — and
    // by the scrolling ones too, for the window's edge (a row scrolled away is fine; one past a box that cannot scroll is not).
    const r = el.getBoundingClientRect();
    let clip = { l: r.left, t: r.top, r: r.right, b: r.bottom };
    let seen = { ...clip };
    let scroller = false;
    const ellipsized = ellipsis(cs) || (el.parentElement !== null && ellipsis(getComputedStyle(el.parentElement)));
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const pcs = getComputedStyle(p);
      const scrolling = scrolls(pcs);
      if (scrolling) scroller = true;
      if (!clips(pcs) && !scrolling && !p.matches("button")) continue;
      const pr = p.getBoundingClientRect();
      seen = { l: Math.max(seen.l, pr.left), t: Math.max(seen.t, pr.top), r: Math.min(seen.r, pr.right), b: Math.min(seen.b, pr.bottom) };
      // Past the nearest scrolling box, a cut is that box's edge (scroll to see the rest) — not a box cutting it short.
      if (!scroller) clip ={ l: Math.max(clip.l, pr.left), t: Math.max(clip.t, pr.top), r: Math.min(clip.r, pr.right), b: Math.min(clip.b, pr.bottom) };
    }
    if (seen.r - seen.l <= 0 || seen.b - seen.t <= 0) continue; // hidden away entirely (a collapsed drawer, a row scrolled out of view)
    const visW = clip.r - clip.l;
    const visH = clip.b - clip.t;
    const cutX = visW < r.width - 1.5 && !ellipsized;
    const cutY = visH < r.height - 1.5;
    if (cutX || cutY) out.push({ kind: "CUT", what: `${describe(el)} (${Math.round(visW)}×${Math.round(visH)} of ${Math.round(r.width)}×${Math.round(r.height)} shows)`, rect: rectOf(r) });
    if (!scroller && (seen.r > vw + 1 || seen.b > vh + 1 || seen.l < -1 || seen.t < -1)) out.push({ kind: "OUTSIDE", what: `${describe(el)} (${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)} in ${vw}×${vh})`, rect: rectOf(r) });
  }

  // NO REASON: a control that is off says why on hover (its own title, or its group's: a radiogroup, a fieldset, a label).
  for (const c of all.filter((el) => el.matches("button:disabled, input:disabled, select:disabled, textarea:disabled, [aria-disabled=true]"))) {
    const holder = c.closest("[title]");
    const said = holder !== null && (holder === c || c.parentElement === holder || holder.matches("[role=radiogroup], [role=group], fieldset, label")) && (holder.getAttribute("title") ?? "").trim() !== "";
    if (!said) out.push({ kind: "NO REASON", what: `${describe(c)} is off with no tooltip saying why`, rect: rectOf(c.getBoundingClientRect()) });
  }

  // CUT select: a closed drop-down cuts its chosen option's text short without an ellipsis (the arrow takes ~20 px).
  const ctx = document.createElement("canvas").getContext("2d");
  for (const sel of all.filter((el): el is HTMLSelectElement => el instanceof HTMLSelectElement)) {
    const label = sel.selectedOptions[0]?.text ?? "";
    if (!ctx || !label) continue;
    const scs = getComputedStyle(sel);
    ctx.font = `${scs.fontStyle} ${scs.fontWeight} ${scs.fontSize} ${scs.fontFamily}`;
    const room = sel.clientWidth - parseFloat(scs.paddingLeft) - parseFloat(scs.paddingRight) - 20;
    const need = ctx.measureText(label).width;
    if (need > room + 1) out.push({ kind: "CUT", what: `${describe(sel)} shows "${label}" in ${Math.round(room)} px of the ${Math.round(need)} it needs`, rect: rectOf(sel.getBoundingClientRect()) });
  }

  // SIDEWAYS: a control or text past the right edge of a scrolling box it sits in (scrolled to its start) — a list or a
  // transcript that scrolls sideways because a row does not fit. Code may.
  for (const box of all) {
    const bcs = getComputedStyle(box);
    const b = box as HTMLElement;
    if (!/auto|scroll/.test(bcs.overflowX) || b.scrollLeft !== 0 || b.scrollWidth <= b.clientWidth + 1) continue;
    const edge = box.getBoundingClientRect().left + b.clientLeft + b.clientWidth;
    const past = [...box.querySelectorAll("*")].find((c) => (isControl(c) || hasOwnText(c)) && !c.closest(`${SKIP}, pre, code, .mono, [data-testid="Unified diff"]`) && shown(c) && c.getBoundingClientRect().right > edge + 1);
    if (past) out.push({ kind: "SIDEWAYS", what: `${describe(past)} pushes ${describe(box).slice(0, 60)} sideways (${b.scrollWidth} > ${b.clientWidth})`, rect: rectOf(past.getBoundingClientRect()) });
  }

  // OVERLAP: controls that are reachable (the topmost thing at their centre is them) whose shown parts intersect.
  const shownRect = (el: Element) => {
    const r = el.getBoundingClientRect();
    let v = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const pcs = getComputedStyle(p);
      if (!clips(pcs) && !scrolls(pcs)) continue;
      const pr = p.getBoundingClientRect();
      v = { left: Math.max(v.left, pr.left), top: Math.max(v.top, pr.top), right: Math.min(v.right, pr.right), bottom: Math.min(v.bottom, pr.bottom) };
    }
    return v;
  };
  const controls = all.filter((el) => el.matches("button, [role=button], a[href], input:not([type=hidden]), select, textarea")).filter((el) => {
    const r = el.getBoundingClientRect();
    const x = Math.min(vw - 1, Math.max(0, r.left + r.width / 2));
    const y = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
    const top = document.elementFromPoint(x, y);
    return top !== null && (top === el || el.contains(top) || top.contains(el));
  });
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i]!;
      const b = controls[j]!;
      if (a.contains(b) || b.contains(a)) continue;
      const ra = shownRect(a);
      const rb = shownRect(b);
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const hgt = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 2 && hgt > 2) out.push({ kind: "OVERLAP", what: `${describe(a)} × ${describe(b)} (${Math.round(w)}×${Math.round(hgt)})`, rect: rectOf(a.getBoundingClientRect()) });
    }
  }

  const text = document.body.innerText;
  if (text.trim().length < 3) out.push({ kind: "BLANK", what: "no text on the page", rect: null });
  const attrs = [...document.querySelectorAll("[title], [aria-label], [placeholder]")].map((el) => ["title", "aria-label", "placeholder"].map((a) => el.getAttribute(a) ?? "").join("\n"));
  const values = [...document.querySelectorAll("input, textarea")].map((el) => (el as HTMLInputElement).value);
  const everything = [text, ...attrs, ...values].join("\n").toLowerCase();
  const home = opts.home.toLowerCase();
  if (home.length > 1 && (everything.includes(home) || everything.includes(home.replace(/\//g, "\\")))) out.push({ kind: "HOME", what: "the real home folder's path is in the page", rect: null });
  return out;
}
