/**
 * docs/PROTOCOL.md §72.2: `/output-style` — the styles the session offers (built-in and custom), the current one marked, and
 * Use Style, which switches it the terminal's way (the CLI writes `.claude/settings.local.json`; the next message uses it).
 * As on the Mac (App OutputStyleSheet.swift); the words in outputStyles.ts.
 */
import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { loadOutputStyles, setOutputStyle, styleBlocker, styleDescription, styleDisplayName, styleSetIn, styleSource, styleWhy, type OutputStyles } from "../../outputStyles";
import { showToast } from "../../toast";
import { Modal } from "../Menu";
import { isEnter } from "../../ime";

export function OutputStyleDialog({ onClose }: { onClose: () => void }) {
  const [styles, setStyles] = useState<OutputStyles | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void loadOutputStyles().then((r) => {
      if ("error" in r) return setError(r.error);
      setStyles(r.styles);
      const current = r.styles.styles.find((s) => r.styles.current?.toLowerCase() === s.name.toLowerCase());
      setPick(current?.name ?? r.styles.styles[0]?.name ?? null);
    });
  }, []);
  const blocker = busy ? t("Switching…") : !styles ? t("Reading the output styles…") : pick === null ? t("Pick a style first") : styleBlocker(styles, pick);
  const use = (name: string | null = pick) => {
    if (name === null || busy || !styles || styleBlocker(styles, name) !== null) return;
    setBusy(true);
    void setOutputStyle(name).then((r) => {
      setBusy(false);
      if (r.ok) {
        showToast(r.notice);
        onClose();
      } else setError(r.notice);
    });
  };
  const setIn = styleSetIn(styles?.setIn ?? null);
  return (
    <Modal title={t("Output Style")} onClose={onClose} testId="Output style dialog">
      <div className="tiny muted">{t("Claude uses the new style from your next message. It is saved to .claude/settings.local.json, as the terminal's /output-style saves it.")}</div>
      <div className="style-list" role="listbox" aria-label={t("Output Style")}>
        {error !== null && <div className="small red">{error}</div>}
        {styles === null && error === null && <div className="small muted">{t("Reading the output styles…")}</div>}
        {styles?.styles.map((s) => {
          const current = styles.current?.toLowerCase() === s.name.toLowerCase();
          const line = styleDescription(s);
          return (
            <div
              key={s.name}
              role="option"
              aria-selected={pick === s.name}
              tabIndex={0}
              className={`style-row${pick === s.name ? " picked" : ""}`}
              title={s.path ?? styleSource(s)}
              onClick={() => setPick(s.name)}
              onDoubleClick={() => use(s.name)}
              onKeyDown={(e) => {
                if (isEnter(e)) use(s.name);
                if (e.key === " ") setPick(s.name);
              }}
              data-testid={`Output style ${s.name}`}
            >
              <span className={`style-mark${current ? " current" : ""}`} aria-hidden>{current ? "●" : "○"}</span>
              <span className="style-text">
                <span className="row">
                  <span className="small bold">{styleDisplayName(s.name)}</span>
                  <span className="tiny muted">{styleSource(s)}</span>
                  {current && <span className="tiny bold accent">{t("Current")}</span>}
                </span>
                {line && <span className="tiny muted">{line}</span>}
              </span>
            </div>
          );
        })}
      </div>
      {setIn && <div className="tiny muted" data-testid="Output style set in">{setIn}</div>}
      {styles && !styles.canSet && <div className="tiny orange" data-testid="Output style why">{styleWhy(styles.why)}</div>}
      <div className="actions">
        <button type="button" onClick={onClose}>{t("Cancel")}</button>
        <button type="button" className="primary" disabled={blocker !== null} title={blocker ?? t("Switch to this style — Claude uses it from your next message")} onClick={() => use()} data-testid="Output style use">
          {t("Use Style")}
        </button>
      </div>
    </Modal>
  );
}
