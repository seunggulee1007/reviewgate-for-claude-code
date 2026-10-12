/**
 * HUD popovers: the §25 model / effort picker behind the model chip and the "⋯" menu (§27 압축…, 모델 변경…).
 * The HUD clips its overflow, so the popovers are portalled to <body> and placed above their anchor.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { EffortLevel } from "@reviewgate/engine";
import { t } from "../../i18n";
import { currentModelOption, effortForSwitch } from "../../hudModel";
import { useStore } from "../../store";
import { AutoModelPickerSection, useModelMode } from "./AutoModelBits"; // MARK: wave5 w5-model (§43.4)

/** A fixed popover above (or below, when there is no room) `anchor`, closed by Escape / a click outside. */
export function AnchoredPopover(props: { anchor: HTMLElement | null; onClose: () => void; children: ReactNode; className?: string; testId?: string; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom?: number; top?: number } | null>(null);
  const width = props.width ?? 340;
  useLayoutEffect(() => {
    const a = props.anchor;
    if (!a) return;
    const r = a.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    const roomAbove = r.top;
    setPos(roomAbove > 260 ? { left, bottom: window.innerHeight - r.top + 6 } : { left, top: r.bottom + 6 });
  }, [props.anchor, width]);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const n = e.target as Node;
      if (ref.current?.contains(n) || props.anchor?.contains(n)) return;
      props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [props]);
  if (!pos) return null;
  return createPortal(
    <div ref={ref} className={`hud-popover ${props.className ?? ""}`} style={{ left: pos.left, bottom: pos.bottom, top: pos.top, width }} data-testid={props.testId}>
      {props.children}
    </div>,
    document.body,
  );
}

export function effortLabel(e: EffortLevel | null): string {
  switch (e) {
    case "low":
      return t("Effort low");
    case "medium":
      return t("Effort medium");
    case "high":
      return t("Effort high");
    case "xhigh":
      return t("Effort extra high");
    case "max":
      return t("Effort max");
    default:
      return t("Model default");
  }
}

export function ModelPicker({ anchor, onClose }: { anchor: HTMLElement | null; onClose: () => void }) {
  const session = useStore((s) => s.state.session);
  const hasProject = useStore((s) => s.state.project !== null);
  const setModel = useStore((s) => s.setModel);
  const models = session.availableModels ?? [];
  const effort = session.effort ?? null;
  const current = currentModelOption(models, session.selectedModel, session.model);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  // MARK: wave5 w5-model — §43.4: in auto no model is "the" choice; picking one is a manual pick.
  const { auto } = useModelMode();
  const saveSettings = useStore((s) => s.saveSettings);

  const apply = async (model: string, eff: EffortLevel | null | undefined) => {
    if (busy || !hasProject) return;
    if (auto) void saveSettings({ modelMode: "manual" }); // MARK: wave5 w5-model
    setBusy(true);
    const err = await setModel(model, eff);
    setBusy(false);
    setNote(err ? { ok: false, text: err } : { ok: true, text: t("Applied — from the next request") });
  };
  const levels = current?.supportsEffort ? (current.supportedEffortLevels ?? []) : [];

  return (
    <AnchoredPopover anchor={anchor} onClose={onClose} className="model-picker" testId="Model picker" width={360}>
      <div className="hp-head">
        <span className="bold">{t("Model")}</span>
        <span className="faint tiny">{t("Applies from the next request · saved for this project")}</span>
      </div>
      <AutoModelPickerSection />{/* MARK: wave5 w5-model — §43.4 */}
      <div className="model-list" role="listbox" aria-label={t("Model")}>
        {models.length === 0 && <div className="note">{t("The session has not reported its models yet.")}</div>}
        {models.map((m) => {
          const on = !auto && current?.value === m.value; // MARK: wave5 w5-model
          return (
            <button
              key={m.value}
              type="button"
              role="option"
              aria-selected={on}
              className={`model-opt ${on ? "on" : ""}`}
              disabled={busy || !hasProject}
              onClick={() => (on ? undefined : void apply(m.value, effortForSwitch(m, effort)))}
              title={m.resolvedModel ?? m.value}
              data-testid={`Model ${m.value}`}
            >
              <span className="check" aria-hidden="true">{on ? "✓" : ""}</span>
              <span className="col" style={{ gap: 1, minWidth: 0, alignItems: "flex-start" }}>
                <span className="model-name">
                  {m.displayName}
                  {m.supportsEffort && <span className="pill gray">{t("effort")}</span>}
                </span>
                {m.description && <span className="model-desc">{m.description}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {current && levels.length > 0 && (
        <div className="effort-row">
          <span className="caption bold">{t("Effort")}</span>
          <div className="effort-seg" role="radiogroup" aria-label={t("Effort")} data-testid="Effort control">
            {[null, ...levels].map((lv) => (
              <button
                key={lv ?? "default"}
                type="button"
                role="radio"
                aria-checked={effort === lv}
                className={effort === lv ? "active" : ""}
                disabled={busy}
                onClick={() => (effort === lv ? undefined : void apply(current.value, lv))}
                data-testid={`Effort ${lv ?? "default"}`}
              >
                {lv === null ? t("Default") : effortLabel(lv)}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className={`hp-foot ${note ? (note.ok ? "ok" : "err") : ""}`} data-testid="Model note">
        {busy ? <span className="spinner" style={{ width: 10, height: 10 }} /> : null}
        {note ? note.text : t("A running turn may pick it up for its remaining requests.")}
      </div>
    </AnchoredPopover>
  );
}

/** "⋯" in the HUD: compact (§27) and the model picker. */
export function HudMenu({ onModel }: { onModel: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const openDialog = useStore((s) => s.openDialog);
  const canSend = useStore((s) => s.state.gate.canSend);
  const hasProject = useStore((s) => s.state.project !== null);
  if (!hasProject) return null;
  return (
    <>
      <button ref={ref} type="button" className="hud-more" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={t("More")} data-testid="HUD menu">
        ⋯
      </button>
      {open && (
        <AnchoredPopover anchor={ref.current} onClose={() => setOpen(false)} className="hud-menu" testId="HUD menu popover" width={240}>
          <button
            type="button"
            className="hm-item"
            disabled={!canSend}
            title={canSend ? t("Summarize the conversation so far to free up context") : t("Claude is working — compact once the turn has ended.")}
            onClick={() => {
              setOpen(false);
              openDialog({ kind: "compact" });
            }}
            data-testid="HUD compact"
          >
            {t("Compact conversation…")}
          </button>
          <button
            type="button"
            className="hm-item"
            onClick={() => {
              setOpen(false);
              onModel();
            }}
            data-testid="HUD change model"
          >
            {t("Model and effort…")}
          </button>
        </AnchoredPopover>
      )}
    </>
  );
}
