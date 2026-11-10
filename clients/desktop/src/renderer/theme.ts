/**
 * M18: the `appearance` setting ("system" | "light" | "dark") resolved to the concrete theme the
 * CSS is written against. The resolved value lives on `document.documentElement.dataset.theme`
 * (`light` / `dark`) — every colour in styles.css comes from a variable defined for both — and is
 * pushed to subscribers (Monaco, src/renderer/monaco.ts). "system" follows
 * `prefers-color-scheme` live through a change listener; main mirrors the same setting onto
 * `nativeTheme.themeSource` so the titlebar and menus follow too.
 */
import type { Appearance } from "../shared/ipc";

export type Theme = "light" | "dark";

const media = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<(theme: Theme) => void>();
let appearance: Appearance = "system";

export function resolvedTheme(): Theme {
  return appearance === "system" ? (media.matches ? "dark" : "light") : appearance;
}

function apply(): void {
  const theme = resolvedTheme();
  if (document.documentElement.dataset.theme === theme) return;
  document.documentElement.dataset.theme = theme;
  for (const cb of listeners) cb(theme);
}

/** Called with `settings.appearance` whenever settings are loaded or saved (src/renderer/store.ts). */
export function setAppearance(a: Appearance | undefined): void {
  appearance = a ?? "system";
  apply();
}

/** Subscribes to the resolved theme; fires immediately with the current one. */
export function onThemeChange(cb: (theme: Theme) => void): () => void {
  listeners.add(cb);
  cb(resolvedTheme());
  return () => listeners.delete(cb);
}

media.addEventListener("change", () => {
  if (appearance === "system") apply();
});

document.documentElement.dataset.theme = resolvedTheme();
