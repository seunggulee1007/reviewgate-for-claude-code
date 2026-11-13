/**
 * MARK: composer parity — docs/PROTOCOL.md §56.3: Ctrl+G edits the composer's draft in an external editor, as in the
 * terminal (main/draftEditor.ts opens and watches it). Each save replaces the draft; an editor that waits ends the editing
 * when it closes; Done keeps what was saved, Cancel puts back the draft from before Ctrl+G. As on the Mac
 * (ComposerExternalEditor.swift).
 */
import { useEffect, useRef, useState } from "react";
import { t } from "./i18n";

export type ExternalEdit = { id: string; name: string; before: string };

/** Ctrl+G alone (Ctrl on every platform, as the terminal's key; never with Shift / Alt / Meta). */
export function isExternalEditKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "g";
}

export function useExternalEdit(setDraft: (text: string) => void, onError: (text: string) => void) {
  const [editing, setEditing] = useState<ExternalEdit | null>(null);
  const current = useRef<ExternalEdit | null>(null);
  current.current = editing;
  const set = useRef(setDraft);
  set.current = setDraft;
  const fail = useRef(onError);
  fail.current = onError;
  useEffect(() => {
    const off = window.rg.onDraftEdit?.((ev) => {
      const e = current.current;
      if (!e || ev.id !== e.id) return; // a finished (or another window's) draft
      if (typeof ev.text === "string") set.current(ev.text);
      if (ev.error) fail.current(t("Couldn't open {0}: {1}", e.name, ev.error));
      if (ev.done) setEditing(null);
    });
    return () => off?.();
  }, []);

  const start = async (draft: string): Promise<void> => {
    if (current.current || !window.rg.draftEditStart) return;
    const r = await window.rg.draftEditStart(draft);
    if (!r.ok) {
      onError(t("Couldn't write the draft for the editor: {0}", r.error));
      return;
    }
    const e = { id: r.id, name: r.name, before: draft };
    current.current = e; // a save may come before the next render
    setEditing(e);
  };
  const finish = (restore: boolean) => {
    const e = current.current;
    if (!e) return;
    setEditing(null);
    current.current = null;
    void window.rg.draftEditFinish?.(e.id);
    if (restore) set.current(e.before);
  };
  return { editing, start, done: () => finish(false), cancel: () => finish(true) };
}
