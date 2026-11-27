// docs/PROTOCOL.md §72.2: `/output-style` — the words and what can be picked. As Core OutputStylesTests on the Mac.
import { beforeAll, describe, expect, it } from "vitest";
import { initI18n } from "./i18n";
import { builtinStyleDescription, styleBlocker, styleDescription, styleDisplayName, styleHelpLine, styleSetIn, styleSource, styleWhy, type OutputStyles } from "./outputStyles";
import { appCommandHint, parseSlashAppCommand, TERMINAL_ONLY } from "./slashAppCommands";

beforeAll(() => initI18n("en", "win32"));

const styles = (over: Partial<OutputStyles> = {}): OutputStyles => ({
  styles: [{ name: "default", description: null, source: "builtin" }, { name: "Concise", description: null, source: "builtin" }, { name: "pirate", description: "Talk like a pirate", source: "user", path: "C:\\Users\\dev\\.claude\\output-styles\\pirate.md" }],
  current: "concise",
  setIn: null,
  canSet: true,
  ...over,
});

describe("§72.2 output styles", () => {
  it("names and explains each style", () => {
    expect(styleDisplayName("default")).toBe("Default");
    expect(styleDisplayName("Concise")).toBe("Concise");
    for (const n of ["default", "Proactive", "Concise", "Explanatory", "Learning"]) expect(builtinStyleDescription(n), n).toBeTruthy();
    expect(styleDescription(styles().styles[2]!)).toBe("Talk like a pirate");
    expect(styleSource(styles().styles[2]!)).toBe("User");
    expect(styleSource({ name: "tutor", description: null, source: "plugin", plugin: "teach" })).toBe("Plugin teach");
    expect(styleHelpLine("default")).toBe("Output style: Default (/output-style)");
  });

  it("says why a style cannot be picked", () => {
    expect(styleBlocker(styles(), "Concise")).toBe("This is the current style"); // any case
    expect(styleBlocker(styles(), "pirate")).toBeNull();
    expect(styleBlocker(styles({ canSet: false, why: "local_settings_off" }), "pirate")).toBe(styleWhy("local_settings_off"));
    expect(styleWhy(undefined)).toBe("The output style can be changed once the session has started");
    expect(styleSetIn(null)).toBeNull();
    expect(styleSetIn({ source: "user", path: "C:\\Users\\dev\\.claude\\settings.json", value: "Concise" })).toBe("Concise is set in C:\\Users\\dev\\.claude\\settings.json");
  });

  it("/output-style is the app's own now, with its style", () => {
    expect(parseSlashAppCommand("/output-style", [])).toEqual({ kind: "outputStyle", name: "" });
    expect(parseSlashAppCommand("/output-style  concise ", [])).toEqual({ kind: "outputStyle", name: "concise" });
    expect(appCommandHint("output-style")).toBe("[style]");
    expect(TERMINAL_ONLY.has("output-style")).toBe(false);
  });
});
