// MARK: lsp — docs/PROTOCOL.md §73.4: the installed app's language server is `resources/lsp` (electron-builder's
// extraResources, outside app.asar so tsserver reads real files); unpackaged, the engine finds the dev workspace itself.
import { app } from "electron";
import { join } from "node:path";

export function lspDir(): string | undefined {
  return app.isPackaged ? join(process.resourcesPath, "lsp") : undefined;
}
