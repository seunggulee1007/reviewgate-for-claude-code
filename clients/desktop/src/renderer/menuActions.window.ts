/**
 * Lane p-window's menu bar actions (polish: Quick Open, project search, the window's panes): a handler per `MenuAction`
 * type, run by `runMenuAction` (menuActions.ts) when App.tsx's `onMenu` has no case for it. Seeded empty by p-foundation;
 * owned by p-window.
 */
import type { MenuActionHandlers } from "./menuActions";

export const windowMenuActions: MenuActionHandlers = {
  // §65.8: File › Go to File… (Ctrl+P) — the palette (nav/QuickOpen.tsx); the store loads with the click.
  quick_open: () => void import("./nav/navStore").then((m) => m.useNav.getState().openPalette("files")),
  // §65.8 Navigate
  nav_palette: (a) => void import("./nav/navStore").then((m) => m.useNav.getState().openPalette(a.mode)),
  nav_reference: (a) =>
    void Promise.all([import("./nav/navStore"), import("./toast"), import("./i18n")]).then(([m, toast, i18n]) => {
      if (!m.useNav.getState().stepReferences(a.dir)) toast.showToast(i18n.t("No references yet — Shift+F12 on a name lists them"));
    }),
  nav_history: (a) => void import("./nav/navStore").then((m) => (a.dir === "back" ? m.useNav.getState().back() : m.useNav.getState().forward())),
  nav_rebuild_index: () =>
    void Promise.all([import("./engineRequest"), import("./toast"), import("./i18n"), import("./errorCodes")]).then(([req, toast, i18n, codes]) =>
      req
        .engineRequest({ type: "nav_index_build", full: true })
        .then(() => toast.showToast(i18n.t("Rebuilding the symbol index…")))
        .catch((e: unknown) => toast.showToast(codes.refusalMessage(req.refusalOf(e)))),
    ),
};
