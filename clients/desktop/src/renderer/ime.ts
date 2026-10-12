/**
 * wave4 w4-input (polish-11): the key that confirms a Korean / Japanese / Chinese IME composition must not also run the
 * field's action. Chromium marks that keydown `isComposing` (on macOS it sends it as keyCode 229, followed by the real
 * Enter), so every Enter handler of a text field asks `isEnter` here instead of comparing `e.key` itself.
 */
export type ImeKeyLike = {
  key: string;
  keyCode?: number;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
};

/** True while the key event belongs to an IME composition (it confirms or edits the composed text). */
export function isComposing(e: Omit<ImeKeyLike, "key">): boolean {
  return e.isComposing === true || e.nativeEvent?.isComposing === true || e.keyCode === 229 || e.nativeEvent?.keyCode === 229;
}

/** A real Enter — not the one that confirms an IME composition. */
export function isEnter(e: ImeKeyLike): boolean {
  return e.key === "Enter" && !isComposing(e);
}
