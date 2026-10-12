/**
 * Stable per-project key for `settings.ui` (M15 pane widths / sidebar tab, M19 window bounds):
 * FNV-1a over the normalized project root. Shared so main and the renderer agree on the key.
 */
export function projectRootHash(root: string): string {
  const norm = root.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
