/**
 * §62 — the DOM diff's line menu entries (components/UnifiedDiff.tsx): Go to Definition / Peek Definition (§65.8) / Find
 * References on the name under the pointer, Open in IDE at the line. The store is loaded on the click, not with the diff (its tests render it alone).
 */
import { t } from "../i18n";
import type { DomNavTarget } from "./domTarget";

export type NavMenuItem = { label: string; keys?: string; onClick: () => void; testId: string; title?: string };

export function navLineMenuItems(target: DomNavTarget | null, at: { x: number; y: number }, ide: { path: string; line: number } | null): NavMenuItem[] {
  const items: NavMenuItem[] = [];
  if (target) {
    items.push(
      {
        label: t("Go to Definition"),
        keys: "F12",
        onClick: () => void import("./NavViews").then((m) => m.goFromDom(target, at.x, at.y)),
        testId: "Line menu go to definition",
        title: `${target.symbol} — ${t("Search-based: may list look-alikes")}`,
      },
      {
        label: t("Peek Definition"),
        keys: "Alt+F12",
        onClick: () => void import("./NavViews").then((m) => m.peekFromDom(target)),
        testId: "Line menu peek definition",
        title: `${target.symbol} — ${t("Shows the definition under this line")}`,
      },
      {
        label: t("Find References"),
        keys: "Shift+F12",
        onClick: () => void import("./navStore").then((m) => m.useNav.getState().findReferences({ symbol: target.symbol, fromPath: target.path })),
        testId: "Line menu find references",
        title: target.symbol,
      },
    );
  }
  if (ide) items.push({ label: t("Open in IDE"), keys: "Ctrl+Alt+O", onClick: () => void import("./openInIde").then((m) => m.openInIde(ide.path, ide.line)), testId: "Line menu open in IDE" });
  return items;
}
