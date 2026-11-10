/**
 * Monaco (0.56 modular ESM): the editor API, the diff editor + a few editor features, every
 * monarch language definition (syntax colours only — no language-service workers), and the
 * editor worker inlined as a blob so it loads from file:// in the packaged app.
 */
import * as monaco from "monaco-editor/editor";
import "monaco-editor/features/codicon/register";
import "monaco-editor/features/diffEditor/register";
import "monaco-editor/features/find/register";
import "monaco-editor/features/folding/register";
import "monaco-editor/features/bracketMatching/register";
import "monaco-editor/features/clipboard/register";
import "monaco-editor/features/contextmenu/register";
import "monaco-editor/features/hover/register";
import "monaco-editor/features/wordHighlighter/register";
import "monaco-editor/features/smartSelect/register";
import "monaco-editor/basic-languages/monaco.contribution";
import EditorWorker from "monaco-editor/editor/editor.worker?worker&inline";
import { onThemeChange } from "./theme";

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker: (moduleId: string, label: string) => Worker };
  }
}

window.MonacoEnvironment = { getWorker: () => new EditorWorker() };

// M18: the editor follows the resolved app theme (src/renderer/theme.ts), not `prefers-color-scheme`.
onThemeChange((theme) => monaco.editor.setTheme(theme === "dark" ? "vs-dark" : "vs"));

let byExtension: Map<string, string> | null = null;
let byFilename: Map<string, string> | null = null;

/** Monaco language id for `path` (by extension / exact filename), or "plaintext". */
export function languageFor(path: string): string {
  if (!byExtension) {
    byExtension = new Map();
    byFilename = new Map();
    for (const lang of monaco.languages.getLanguages()) {
      for (const ext of lang.extensions ?? []) if (!byExtension.has(ext.toLowerCase())) byExtension.set(ext.toLowerCase(), lang.id);
      for (const name of lang.filenames ?? []) byFilename!.set(name.toLowerCase(), lang.id);
    }
  }
  const base = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const exact = byFilename!.get(base);
  if (exact) return exact;
  const dot = base.lastIndexOf(".");
  if (dot >= 0) {
    const ext = base.slice(dot);
    return byExtension.get(ext) ?? "plaintext";
  }
  return "plaintext";
}

export { monaco };
