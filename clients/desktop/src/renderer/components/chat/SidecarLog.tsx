/** Collapsible "Engine log (N)" — the last 500 engine `log` events, so IPC problems are diagnosable without a terminal. */
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { useStore } from "../../store";

export function SidecarLog() {
  const logs = useStore((s) => s.logs);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (open && el) el.scrollTop = el.scrollHeight;
  }, [open, logs.length]);
  return (
    <details className="sidecar-log" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)} style={{ padding: "0 12px 8px" }} data-testid="Sidecar log">
      <summary>{t("Engine log ({0})", logs.length)}</summary>
      {open && (
        <div className="logbox" ref={boxRef}>
          {logs.length === 0 ? t("(no engine log yet)") : logs.join("\n")}
        </div>
      )}
    </details>
  );
}
