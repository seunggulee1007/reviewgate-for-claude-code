/**
 * docs/PROTOCOL.md §72.1: `/hooks` in a classic chat — the hooks in effect, read-only, as the terminal's `/hooks` browser
 * lists them (`hooks_list`). The grouping and the words; the dialog is components/dialogs/HooksDialog.tsx. As on the Mac
 * (Core HooksList.swift); its Korean comes from the Mac's catalog through gen-i18n.mjs.
 */
import type { HookEntry, HookSource, HooksListEvent } from "@reviewgate/engine";
import { engineRequest, refusalOf } from "./engineRequest";
import { t } from "./i18n";
import { refusalMessage } from "./errorCodes";

/** The hooks reference's 34 events, in its lifecycle order (2026-11). */
export const HOOK_EVENTS = [
  "SessionStart", "Setup", "UserPromptSubmit", "UserPromptExpansion", "PreSkillShellCommand", "PreToolUse", "PermissionRequest",
  "PermissionDenied", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "Notification", "MessageDisplay", "SubagentStart",
  "SubagentStop", "TaskCreated", "TaskCompleted", "Stop", "StopFailure", "TeammateIdle", "InstructionsLoaded", "ConfigChange",
  "CwdChanged", "DirectoryAdded", "FileChanged", "WorktreeCreate", "WorktreeRemove", "PreCompact", "PostCompact", "PreModelSwitch",
  "PostModelSwitch", "Elicitation", "ElicitationResult", "SessionEnd",
] as const;

export type HooksList = Omit<HooksListEvent, "type" | "id">;

/** The hooks by event in the engine's (lifecycle) order; `allEvents`: every event, an empty one too (the terminal's All events). */
export function hooksByEvent(hooks: readonly HookEntry[], allEvents = false): { event: string; hooks: HookEntry[] }[] {
  const order: string[] = [];
  const groups = new Map<string, HookEntry[]>();
  for (const h of hooks) {
    if (!groups.has(h.event)) order.push(h.event);
    groups.set(h.event, [...(groups.get(h.event) ?? []), h]);
  }
  const events = allEvents ? [...HOOK_EVENTS, ...order.filter((e) => !(HOOK_EVENTS as readonly string[]).includes(e))] : order;
  return events.map((event) => ({ event, hooks: groups.get(event) ?? [] }));
}

export const hooksDescription = (): string => t("Show the hooks that run — each one's event, matcher and where it is defined");

export function hookSourceLabel(source: HookSource, plugin?: string): string {
  switch (source) {
    case "user": return t("User settings");
    case "project": return t("Project settings");
    case "local": return t("Local settings");
    case "plugin": return plugin ? t("Plugin {0}", plugin) : t("Plugin");
    case "managed": return t("Managed policy");
  }
}

export const matcherLabel = (m: string): string => (m === "" ? t("Any") : m);

/** "if Bash(rm *) · 30 s timeout · runs in the background · “Checking…”" — "" when the handler says nothing more. */
export function hookDetails(h: HookEntry): string {
  const parts: string[] = [];
  if (h.if) parts.push(t("if {0}", h.if));
  if (h.timeout !== undefined) parts.push(t("{0} s timeout", Math.round(h.timeout)));
  if (h.async) parts.push(t("runs in the background"));
  if (h.statusMessage) parts.push(`“${h.statusMessage}”`);
  return parts.join(" · ");
}

/** The line over the list when the hooks do not run; null when they do. */
export function hooksOffText(off: HooksList["off"]): string | null {
  switch (off) {
    case "app": return t("Your hooks are off in ReviewGate (Settings › Extensions) — they are listed but do not run. ReviewGate's own safety hooks still run.");
    case "settings": return t("disableAllHooks is on in your settings — these hooks are listed but do not run.");
    case "managed_only": return t("Your organization's policy allows only its managed hooks — the others do not run.");
    case "managed": return t("Your organization's policy turned off every hook.");
    default: return null;
  }
}

/** Open in Editor's tooltip, or why it is disabled. */
export function hookOpenHelp(path: string, exists: boolean): string {
  return exists ? t("Open {0} in your editor", path) : t("{0} does not exist yet — this chat would read it", path);
}

/** `hooks_list`, or the refusal in words. */
export async function loadHooks(): Promise<{ list: HooksList } | { error: string }> {
  try {
    const { type: _type, id: _id, ...list } = await engineRequest({ type: "hooks_list" });
    return { list };
  } catch (e: unknown) {
    return { error: refusalMessage(refusalOf(e)) };
  }
}
