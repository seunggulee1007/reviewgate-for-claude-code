/**
 * MARK: wave5 w5-fixes — docs/PROTOCOL.md §43.5: the basis of "plan vs actual" chosen from a menu on the newest turn
 * summary (the Mac's Core `PlanBasis`, same words). `state.session.planSource` (§42.1) says what the next summary compares
 * against and which plan files there are; `plan_follow {path}` chooses one (null: back to the automatic sources). An older
 * engine sends no `planSource`: no menu. A plan approved in ReviewGate comes first, so the menu shows but cannot change it.
 */
import type { PlanSourceState } from "@reviewgate/engine";
import { t } from "./i18n";
import { tildePath } from "./peerSessions";

export type PlanBasisItem = {
  /** null: the automatic sources (the plan file the chat names, Claude's to-do list, the first message's list). */
  path: string | null;
  title: string;
  /** The full path, or what the automatic sources are. */
  help: string;
  checked: boolean;
};

export type PlanBasisMenuModel = {
  /** The button: "기준: 자동 · db-migration.md". */
  label: string;
  /** Automatic first, then the plan files. */
  items: PlanBasisItem[];
  /** Why nothing can be chosen now (a plan approved in ReviewGate); null = the items work. */
  blocker: string | null;
  /** The line under the items. */
  note: string;
  /** The plan file the chat chose (null: automatic, or a plan approved here). */
  chosenPath: string | null;
};

const name = (path: string): string => {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
};

/** "db-migration.md  ·  .omc/plans" — the name, then its folder (`~/…` under the home folder; none at the root). */
export function planBasisFileTitle(path: string): string {
  const shown = tildePath(path);
  const cut = Math.max(shown.lastIndexOf("/"), shown.lastIndexOf("\\"));
  const folder = cut > 0 ? shown.slice(0, cut) : "";
  return folder ? `${name(shown)}  ·  ${folder}` : name(shown);
}

function current(source: PlanSourceState, chosen: string | null): string {
  if (source.kind === "approved") return t("Approved plan");
  if (chosen) return name(chosen);
  const what =
    source.kind === "file" ? (source.path ? name(source.path) : null)
    : source.kind === "todos" ? t("Claude's to-do list")
    : source.kind === "message" ? t("Your first message's list")
    : source.kind === "request" ? t("Request scope")
    : null;
  return what ? t("Automatic · {0}", what) : t("Automatic");
}

/** The menu for `planSource` (null on an older engine / without a chat). */
export function planBasisMenu(source: PlanSourceState | undefined | null): PlanBasisMenuModel | null {
  if (!source) return null;
  const approved = source.kind === "approved";
  const chosen = source.chosen === true && source.kind === "file" && source.path ? source.path : null;
  const files = [...(source.candidates ?? [])];
  if (chosen && !files.includes(chosen)) files.unshift(chosen);
  const items: PlanBasisItem[] = [
    { path: null, title: t("Choose automatically"), help: t("The plan file the chat names, Claude's to-do list, then your first message's list"), checked: !approved && chosen === null },
    ...files.map((p) => ({ path: p, title: planBasisFileTitle(p), help: p, checked: !approved && p === chosen })),
  ];
  return {
    label: t("Basis: {0}", current(source, chosen)),
    items,
    blocker: approved ? t("This chat follows the plan you approved in ReviewGate") : null,
    note: files.length === 0 ? t("No plan files yet — .omc/plans, .claude/plans and plan files under docs/ show up here") : t("The next turn summary compares against it"),
    chosenPath: items.find((i) => i.checked)?.path ?? null,
  };
}
