/**
 * `gate.changedOutside` / `ignoredTouched` / `filteredByPattern` chips above the changed-files list in
 * `ChangedFiles` (docs/PROTOCOL.md §8). With more than one kind present they merge into a single
 * "N notices" chip (M16 banner tidy). The one-time "restored" banner lives in `BannerStack`.
 */
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { memoryFile, memoryLabel } from "../scopeNotices"; // MARK: r1-scope (§8)
import { useStore } from "../store";

/** `named`: how a path reads in the list (null: the path itself). */
type Group = { label: string; paths: string[]; openable: boolean; named?: (path: string) => string | null };

/** r1-scope (§8): a note Claude wrote into its own memory reads "메모리에 기록: <file>". */
function outsideName(path: string): string | null {
  const memory = memoryFile(path);
  return memory ? memoryLabel(memory) : null;
}

function ChipPopover({ groups, onClose }: { groups: Group[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div className="popover" ref={ref} data-testid="Gate notice popover">
      {groups.map((g) => (
        <div key={g.label} className="group">
          {groups.length > 1 && <h4>{g.label}</h4>}
          {g.paths.map((p) => (
            <div key={p} className="row" style={{ gap: 6, padding: "2px 0" }}>
              {g.named?.(p) ? (
                <span className="truncate grow" title={p} data-testid={`Memory note ${p}`}>{g.named(p)}</span>
              ) : (
                <span className="mono truncate grow" title={p}>{p}</span>
              )}
              {g.openable && (
                <button type="button" className="small" onClick={() => void window.rg.openInEditor(p, 1)} data-testid={`Open ${p}`}>
                  {t("Open")}
                </button>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Chip({ label, groups, testId }: { label: string; groups: Group[]; testId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: "relative" }}>
      <button type="button" className="pill orange" style={{ cursor: "pointer", border: 0 }} onClick={() => setOpen((v) => !v)} data-testid={testId}>
        {label}
      </button>
      {open && <ChipPopover groups={groups} onClose={() => setOpen(false)} />}
    </span>
  );
}

export function GateNotices() {
  const gate = useStore((s) => s.state.gate);
  const groups: (Group & { testId: string })[] = [
    { label: t("{0} edit(s) outside the project", gate.changedOutside.length), paths: gate.changedOutside, openable: true, named: outsideName, testId: "Chip changedOutside" },
    { label: t("{0} ignored file(s) touched", gate.ignoredTouched.length), paths: gate.ignoredTouched, openable: false, testId: "Chip ignoredTouched" },
    { label: t("{0} file(s) filtered by pattern", gate.filteredByPattern.length), paths: gate.filteredByPattern, openable: false, testId: "Chip filteredByPattern" },
  ].filter((g) => g.paths.length > 0);
  if (groups.length === 0) return null;

  return (
    <div className="row wrap" style={{ gap: 6, padding: "0 12px 6px" }}>
      {groups.length === 1 ? (
        <Chip label={groups[0]!.label} groups={groups} testId={groups[0]!.testId} />
      ) : (
        <Chip label={t("{0} notices", groups.reduce((n, g) => n + g.paths.length, 0))} groups={groups} testId="Chip notices" />
      )}
    </div>
  );
}
