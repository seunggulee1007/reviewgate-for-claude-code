/**
 * MARK: wave5 w5-graph — docs/PROTOCOL.md §43.3 [graph.html 열기]: graphify's graph.html opened in the default browser. The
 * renderer's path is checked here: absolute, no control characters, a file named graph.html inside a graphify-out folder,
 * and it exists — never another page, a program or a folder.
 */
import { statSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";

export function isOpenableGraphHtml(path: unknown, stat: (p: string) => { isFile(): boolean } = statSync): path is string {
  if (typeof path !== "string" || !isAbsolute(path) || /[\0-\x1f]/.test(path)) return false;
  const normalized = path.replace(/\\/g, "/");
  if (basename(normalized) !== "graph.html" || basename(dirname(normalized)) !== "graphify-out") return false;
  try {
    return stat(path).isFile();
  } catch {
    return false;
  }
}
