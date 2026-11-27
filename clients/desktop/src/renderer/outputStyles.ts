/**
 * docs/PROTOCOL.md §72.2: `/output-style [style]` in a classic chat — the styles the session offers, the current one, and a
 * switch through the CLI's own settings writer (`.claude/settings.local.json`, live from the next message). The words and
 * the requests; the dialog is components/dialogs/OutputStyleDialog.tsx. As on the Mac (Core OutputStyles.swift); the
 * Korean comes from the Mac's catalog through gen-i18n.mjs.
 */
import type { OutputStyleInfo, OutputStylesEvent, OutputStyleSetIn } from "@reviewgate/engine";
import { engineRequest, refusalOf } from "./engineRequest";
import { refusalMessage } from "./errorCodes";
import { t } from "./i18n";

export type OutputStyles = Omit<OutputStylesEvent, "type" | "id">;

export const outputStyleDescription = (): string => t("Choose how Claude answers — the output style, as the terminal's /output-style");

/** "default" reads "Default". */
export const styleDisplayName = (name: string): string => (name.toLowerCase() === "default" ? t("Default") : name);

/** A built-in's line (the output-styles page's table); null for any other name. */
export function builtinStyleDescription(name: string): string | null {
  switch (name.toLowerCase()) {
    case "default": return t("Claude Code's standard instructions for software engineering");
    case "proactive": return t("Starts work right away and makes reasonable assumptions instead of asking about routine decisions");
    case "concise": return t("Leads with the result and leaves out the preamble, the narration and the recap");
    case "explanatory": return t("Adds short Insight blocks that explain the choices behind the code");
    case "learning": return t("Explains its choices and leaves small pieces of code for you to write");
    default: return null;
  }
}

export const styleDescription = (s: OutputStyleInfo): string | null => (s.source === "builtin" ? builtinStyleDescription(s.name) : s.description);

export function styleSource(s: OutputStyleInfo): string {
  switch (s.source) {
    case "builtin": return t("Built-in style");
    case "user": return t("User");
    case "project": return t("Project");
    case "plugin": return s.plugin ? t("Plugin {0}", s.plugin) : t("Plugin");
    case "managed": return t("Managed policy");
    default: return "Claude Code";
  }
}

/** Where the style that applies is set; null without a settings value. */
export function styleSetIn(s: OutputStyleSetIn | null): string | null {
  if (!s) return null;
  return s.source === "managed" ? t("Your organization's policy sets the style ({0})", s.value) : t("{0} is set in {1}", s.value, s.path);
}

/** Why the style cannot be switched now. */
export function styleWhy(why: OutputStylesEvent["why"]): string {
  switch (why) {
    case "local_settings_off": return t("This project's chats do not load .claude/settings.local.json (Settings › Extensions), where the style is saved");
    case "unsupported": return t("This Claude Code cannot switch the style from the app — update it, or use a terminal chat");
    default: return t("The output style can be changed once the session has started");
  }
}

/** Why `name` cannot be picked now; null when it can. */
export function styleBlocker(styles: OutputStyles, name: string): string | null {
  if (!styles.canSet) return styleWhy(styles.why);
  if (styles.current && styles.current.toLowerCase() === name.toLowerCase()) return t("This is the current style");
  return null;
}

export const styleSwitched = (name: string): string => t("Output style: {0} — Claude uses it from your next message", styleDisplayName(name));
export const styleMenuItem = (name: string): string => t("Output Style: {0}…", styleDisplayName(name));
export const styleHelpLine = (name: string): string => t("Output style: {0} (/output-style)", styleDisplayName(name));

/** `output_styles`, or the refusal in words. */
export async function loadOutputStyles(): Promise<{ styles: OutputStyles } | { error: string }> {
  try {
    const { type: _type, id: _id, ...styles } = await engineRequest({ type: "output_styles" });
    return { styles };
  } catch (e: unknown) {
    return { error: refusalMessage(refusalOf(e)) };
  }
}

/** `output_style_set {name}` (any case): the composer's line. */
export async function setOutputStyle(name: string): Promise<{ ok: true; styles: OutputStyles; notice: string } | { ok: false; notice: string }> {
  try {
    const { type: _type, id: _id, ...styles } = await engineRequest({ type: "output_style_set", name });
    return { ok: true, styles, notice: styleSwitched(styles.current ?? name) };
  } catch (e: unknown) {
    return { ok: false, notice: refusalMessage(refusalOf(e)) };
  }
}
