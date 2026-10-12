import { randomUUID } from "node:crypto";

/** Which side of the diff a review note points at. */
export type DiffSide = "old" | "new";

/** One inline note on the current turn's diff (docs/M8-API.md request-changes flow). */
export type ReviewNote = {
  id: string;
  path: string;
  line: number | null;
  side: DiffSide;
  /** The line text the note was left on. */
  excerpt: string;
  body: string;
  /**
   * §34.4: the note went to Claude with `request_changes` (the follow-up turn's number). A sent note stays in the review
   * as "요청함 — 반영 확인" until the user removes it (`remove_note`) or the review ends; it is never sent again and does
   * not count for `canRequestChanges` / `noteCount`.
   */
  sent?: { at: string; turn: number };
  /**
   * §34.4: `line` (new side) was remapped after B changed: `moved` — the line moved and `line` is its new number;
   * `gone` — the line no longer exists ("위치 사라짐"; `line` keeps its last number). Absent: at `line` as created.
   */
  anchor?: NoteAnchor;
};

/** §34.4: what happened to a note's line after the file changed again. */
export type NoteAnchor = "moved" | "gone";

export function makeNote(note: Omit<ReviewNote, "id"> & { id?: string }): ReviewNote {
  return { id: note.id ?? randomUUID(), path: note.path, line: note.line, side: note.side, excerpt: note.excerpt, body: note.body };
}

/**
 * "[Review gate] Requested changes on this turn's diff. Keep the other changes as they are.\n- path:line (side) `excerpt` — body\n…\n\n<extra>"
 * Byte-identical to `SessionStore.requestChangesMessage`.
 */
export function requestChangesMessage(notes: readonly ReviewNote[], extra?: string | null): string {
  let text = "[Review gate] Requested changes on this turn's diff. Keep the other changes as they are.";
  for (const note of notes) text += noteItem(note);
  const trimmedExtra = extra?.trim();
  if (trimmedExtra) text += "\n\n" + trimmedExtra;
  return text;
}

/** "\n- path:line (side) `excerpt` — body" */
function noteItem(note: ReviewNote): string {
  let item = "\n- " + note.path;
  if (note.line !== null && note.line !== undefined) item += `:${note.line}`;
  item += ` (${note.side})`;
  const excerpt = note.excerpt.trim();
  if (excerpt.length > 0) item += ` \`${excerpt}\``;
  return item + " — " + note.body;
}

/**
 * A plain message during a review carries the notes not sent yet, so "메모 반영해줘" in the chat reaches them. They stay
 * unsent (Request changes still sends them); Claude is told to act on them only when the message asks.
 */
export function unsentNotesContext(notes: readonly ReviewNote[]): string {
  let text = "[Review gate] Notes the user left on the diff, not sent yet (act on them only if the message above asks):";
  for (const note of notes) text += noteItem(note);
  return text;
}
