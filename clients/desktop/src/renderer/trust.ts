/**
 * MARK: wave4c w4c-trust — docs/PROTOCOL.md §41.2 (Electron; the Mac's Core `TrustRules.swift` says the same words): the
 * auto-accept rules' names, what [모두 대기로 되돌리기] and the reject banner's [거절 취소] can do right now, and why not.
 * Pure (no store, no bridge): the views in components/trust/TrustViews.tsx send the commands.
 */
import type { AutoAcceptRule, AutoAcceptRules, ChangedFileState, GateState, ReviewState } from "@reviewgate/engine";
import { t } from "./i18n";

/** Settings order. */
export const TRUST_RULES: readonly AutoAcceptRule[] = ["whitespace", "lockfile", "tests"];

/** The rule's short name ("규칙으로 수락 · 공백만 바뀜"); null for a rule this client does not know (a newer engine). */
export function trustRuleName(rule: string | undefined): string | null {
  switch (rule) {
    case "whitespace":
      return t("Whitespace only");
    case "lockfile":
      return t("Lockfile with its manifest");
    case "tests":
      return t("Test passed after the edit");
    default:
      return null;
  }
}

/** One line under the rule's switch in Settings › Project. */
export function trustRuleHelp(rule: AutoAcceptRule): string {
  switch (rule) {
    case "whitespace":
      return t("Files whose every change is whitespace — not Python, YAML or Makefiles, where whitespace is code.");
    case "lockfile":
      return t("A lockfile (package-lock.json, yarn.lock, gradle.lockfile …) when you accept the manifest next to it.");
    case "tests":
      return t("Test files (*Test.java, *.test.ts …) when the turn's last test passed after its last edit.");
  }
}

/** What no rule ever accepts (Settings › Project, under the switches). */
export function trustNeverText(): string {
  return t("Never accepted by a rule: files with a risk badge (settings, SQL, schema, CI, permissions), changes made by Bash, an MCP tool or outside Claude, large files, files with notes and files you rejected.");
}

/** The badge's tooltip on a file a rule accepted. */
export function autoAcceptedHelp(rule: string | undefined): string {
  const name = trustRuleName(rule);
  return name ? t("Accepted by the rule “{0}” — not reviewed by you. [Back to pending] on the turn summary puts it back.", name) : t("Accepted by a rule — not reviewed by you.");
}

export function enabledTrustRules(rules: AutoAcceptRules | undefined): AutoAcceptRule[] {
  return TRUST_RULES.filter((r) => rules?.[r] === true);
}

/** The files of `paths` (all when absent) a rule still holds accepted. */
export function ruleAccepted(files: readonly ChangedFileState[], paths?: readonly string[]): string[] {
  const want = paths ? new Set(paths) : null;
  return files.filter((f) => f.state === "accepted" && typeof f.autoAccepted === "string" && (!want || want.has(f.path))).map((f) => f.path);
}

const busy = (gate: GateState) => gate.phase === "running" || gate.phase === "collecting" || gate.phase === "reverting";

/** [모두 대기로 되돌리기] of a turn summary: the files a rule still holds and why the button waits (null: ready). */
export function autoUndoView(state: Pick<ReviewState, "changedFiles" | "gate">, paths: readonly string[]): { paths: string[]; blocked: string | null } {
  const held = ruleAccepted(state.changedFiles, paths);
  if (held.length === 0) return { paths: held, blocked: t("Already back to pending or out of the review") };
  if (busy(state.gate)) return { paths: held, blocked: t("Claude is working — wait for the turn to end") };
  return { paths: held, blocked: null };
}

/** The "거절했어요 — [거절 취소]" banner: absent without an offer; `blocked` says why the button is disabled. */
export function rejectUndoView(state: Pick<ReviewState, "gate">): { path: string; blocked: string | null } | null {
  const u = state.gate.rejectUndo;
  if (!u || typeof u.path !== "string") return null;
  if (u.available === false) {
    const blocked =
      u.reason === "changed_on_disk"
        ? t("The file changed after the reject — it can no longer be put back")
        : t("The review changed after the reject — it can no longer be put back");
    return { path: u.path, blocked };
  }
  if (busy(state.gate)) return { path: u.path, blocked: t("Claude is working — wait for the turn to end") };
  return { path: u.path, blocked: null };
}
