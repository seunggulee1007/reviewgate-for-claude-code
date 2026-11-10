/**
 * Background work in the HUD (docs/PROTOCOL.md §52): "백그라운드 N" while Claude has commands running in the background
 * (`state.session.backgroundTasks`; nothing while there are none). A click lists them — description, kind, turn, start —
 * with [출력 보기] (the last 64 KB of the task's output) and [중지]. A refusal is one orange line in the user's words.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { backgroundChipText, backgroundTasksOf, taskMetaLine, taskTitle, type BackgroundTask, type TaskOutput } from "../../background";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { Modal } from "../Menu";
import { AnchoredPopover } from "./HudPopovers";
import "../reviewRound.css";

export function BackgroundChip() {
  const session = useStore((s) => s.state.session);
  const tasks = backgroundTasksOf(session);
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<BackgroundTask | null>(null);
  const label = backgroundChipText(tasks);
  // The last task ended while the list was open: it closes with it.
  useEffect(() => {
    if (tasks.length === 0) setOpen(false);
  }, [tasks.length]);
  if (!label) return null;
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="live-chip bg-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={t("Commands Claude runs in the background — click to see them")}
        data-testid="HUD background"
      >
        <span className="round-pulse" aria-hidden="true" />
        <span className="num">{label}</span>
      </button>
      {open && (
        <AnchoredPopover anchor={ref.current} onClose={() => setOpen(false)} className="bg-popover" testId="HUD background popover" width={360}>
          <BackgroundList tasks={tasks} onOutput={setViewing} />
        </AnchoredPopover>
      )}
      {viewing && <TaskOutputDialog task={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}

export function BackgroundList({ tasks, onOutput }: { tasks: BackgroundTask[]; onOutput: (t: BackgroundTask) => void }) {
  const stop = useStore((s) => s.stopBackgroundTask);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [stopping, setStopping] = useState<string | null>(null);
  const doStop = async (id: string) => {
    setStopping(id);
    const why = await stop(id);
    setStopping(null);
    setNotes((n) => {
      const { [id]: _old, ...rest } = n;
      return why ? { ...rest, [id]: why } : rest;
    });
  };
  return (
    <div className="bg-list">
      <div className="bold">{t("Running in the background")}</div>
      <div className="tiny muted">{t("When one finishes, Claude goes on. Files changed in the meantime join the next review.")}</div>
      {tasks.map((task) => (
        <div key={task.taskId} className="bg-task" data-testid={`Background task ${task.taskId}`}>
          <div className="bg-title truncate" title={taskTitle(task)}>{taskTitle(task)}</div>
          <div className="tiny muted">{taskMetaLine(task)}</div>
          <div className="bg-actions">
            {task.hasOutput && (
              <button type="button" className="small" onClick={() => onOutput(task)} data-testid="Show task output">
                {t("Show output")}
              </button>
            )}
            <button type="button" className="small" disabled={stopping === task.taskId} onClick={() => void doStop(task.taskId)} data-testid="Stop task">
              {t("Stop")}
            </button>
          </div>
          {notes[task.taskId] && <div className="tiny orange" role="status" data-testid="Stop task note">{notes[task.taskId]}</div>}
        </div>
      ))}
    </div>
  );
}

/** [출력 보기]: the monospaced text (the last 64 KB), 새로고침, and whether the task still runs. */
export function TaskOutputDialog({ task, onClose }: { task: BackgroundTask; onClose: () => void }) {
  const read = useStore((s) => s.readTaskOutput);
  const [out, setOut] = useState<TaskOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    const r = await read(task.taskId);
    if (r.ok) {
      setOut(r.output);
      setError(null);
    } else setError(r.error);
    setLoading(false);
  }, [read, task.taskId]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <Modal title={taskTitle(task)} onClose={onClose} wide testId="Task output dialog">
      <div className="row" style={{ gap: 8 }}>
        {out && <span className="pill gray" data-testid="Task output state">{out.running ? t("Running") : t("Ended")}</span>}
        {out?.truncated && <span className="tiny muted" data-testid="Task output truncated">{t("Only the last 64 KB are shown")}</span>}
        <span className="spacer" />
        <button type="button" className="small" disabled={loading} onClick={() => void load()} data-testid="Refresh task output">
          {t("Refresh")}
        </button>
      </div>
      {error && <div className="tiny orange" role="status" data-testid="Task output error">{error}</div>}
      {out && <pre className="mono bg-output" data-testid="Task output text">{out.text}</pre>}
      <div className="actions">
        <button type="button" onClick={onClose}>{t("Close")}</button>
      </div>
    </Modal>
  );
}
