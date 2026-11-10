/**
 * MARK: polish p-ui-kit — P1-chrome-31 / P2-review-31 / P4-composer-12: where a key moves the focus in an open menu
 * (components/Menu.tsx), as Windows' menus and the WAI-ARIA menu pattern do: ↓ / ↑ go round, Home / End jump to the ends,
 * a letter goes to the next item that starts with it — a Hangul consonant to the next item whose first syllable starts
 * with it (ㄱ → 감추기). A disabled item can be focused (a screen reader reads it and its reason), never chosen.
 *
 *   const next = menuKeyTarget(e.key, items.indexOf(focused), items.map((el) => ({ text: el.textContent ?? "", disabled })));
 *   if (next !== null) items[next].focus();
 */

export type MenuNavItem = { text: string; disabled: boolean };

/** The index the key moves the focus to; `current` −1 = no item has it yet (the menu opened by a click). null: the key does not move it. */
export function menuKeyTarget(key: string, current: number, items: readonly MenuNavItem[]): number | null {
  const n = items.length;
  if (n === 0) return null;
  switch (key) {
    case "ArrowDown":
      return current < 0 ? firstEnabled(items) : (current + 1) % n;
    case "ArrowUp":
      return current < 0 ? lastEnabled(items) : (current - 1 + n) % n;
    case "Home":
      return 0;
    case "End":
      return n - 1;
  }
  if (Array.from(key).length !== 1 || key.trim() === "") return null;
  for (let step = 1; step <= n; step++) {
    const i = (current + step + n) % n;
    if (startsWithKey(items[i]!.text, key)) return i;
  }
  return null;
}

/** The item a menu opened from the keyboard focuses first: the first one that can be chosen (else the first). */
export function firstEnabled(items: readonly MenuNavItem[]): number {
  const i = items.findIndex((it) => !it.disabled);
  return i === -1 ? 0 : i;
}

export function lastEnabled(items: readonly MenuNavItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) if (!items[i]!.disabled) return i;
  return items.length - 1;
}

// The initial consonants of the Hangul syllables (가 … 힣), in their order, as the compatibility jamo a keyboard types.
const CHOSEONG = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";

function startsWithKey(text: string, key: string): boolean {
  const first = Array.from(text.trim())[0];
  if (first === undefined) return false;
  if (first.toLocaleLowerCase() === key.toLocaleLowerCase()) return true;
  const code = first.charCodeAt(0) - 0xac00;
  return code >= 0 && code < 11172 && CHOSEONG[Math.floor(code / 588)] === key;
}
