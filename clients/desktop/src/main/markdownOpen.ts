/**
 * MARK: wave4d w4d-config — docs/PROTOCOL.md §42.3 "에디터에서 열기": an instruction file (CLAUDE.md, a memory file, a
 * subagent's definition) opened in the system's default app. The renderer's path is checked here: absolute, no control
 * characters, a Markdown file that exists — never a program or a folder the default app would run or browse.
 */
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

export function isOpenableMarkdown(path: unknown, stat: (p: string) => { isFile(): boolean } = statSync): path is string {
  if (typeof path !== "string" || !isAbsolute(path) || /[\0-\x1f]/.test(path) || !/\.(md|markdown)$/i.test(path)) return false;
  try {
    return stat(path).isFile();
  } catch {
    return false;
  }
}
