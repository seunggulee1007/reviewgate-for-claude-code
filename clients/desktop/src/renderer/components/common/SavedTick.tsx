/**
 * MARK: polish p-foundation — P5-sheets-34: "✓ 저장했어요" beside a field for 1.5 s after what it stores changed — the field
 * says it saved. Give it the stored value (not the draft): it shows each time that value changes after it appeared.
 *
 *   <SavedTick value={settings.bashAllowPatterns} />
 */
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { Icon } from "../../icons";
import "./common.css";

export const SAVED_TICK_MS = 1500;

export function SavedTick({ value }: { value: unknown }) {
  const first = useRef(true);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setShown(true);
    const id = setTimeout(() => setShown(false), SAVED_TICK_MS);
    return () => clearTimeout(id);
  }, [value]);
  return (
    <span className={`rg-saved-tick ${shown ? "shown" : ""}`} role="status" aria-live="polite" data-testid="Saved tick">
      {shown && (
        <>
          <Icon name="check" size={12} />
          {t("Saved")}
        </>
      )}
    </span>
  );
}
