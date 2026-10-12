/**
 * A user message in the transcript: the text, its §23 mentions as chips and its §24 images as thumbnails (fetched
 * lazily with `attachment_get`, cached; click to enlarge). Hovering shows 복사 · 수정해서 다시 보내기 · 이 시점으로
 * 되돌리기 (§26): the inline editor rewinds the conversation — and Claude's file changes, when checked — to just before
 * this message and sends the edited text as the new turn; the dialog rewinds without sending.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AttachmentRef } from "@reviewgate/engine";
import { storedToDraft, type DraftImage } from "../../composerAttach";
import { t } from "../../i18n";
import { addMentions } from "../../mentions";
import { editRetryMode, rewindAvailability } from "../../rewind";
import { useStore, type ChatItem } from "../../store";
import { attachmentData, dataURL } from "../../storeComposer";
import { RewindRefusalNote, useRewindRun } from "../dialogs/RewindDialog";
import { DraftChips, ImageViewer, MentionChip } from "./ComposerChips";
import { isEnter } from "../../ime";
import { AutoModelSwitchLine } from "./AutoModelBits"; // MARK: wave5 w5-model (§43.4)

type UserItem = Extract<ChatItem, { kind: "user" }>;

/** One stored image: fetched when it scrolls into view. */
export function AttachmentThumb({ att }: { att: AttachmentRef }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [big, setBig] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    const load = () =>
      attachmentData(att.hash)
        .then((d) => live && setUrl(dataURL(d)))
        .catch(() => live && setFailed(true));
    if (typeof IntersectionObserver === "undefined") {
      void load();
      return () => {
        live = false;
      };
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        void load();
      }
    });
    io.observe(el);
    return () => {
      live = false;
      io.disconnect();
    };
  }, [att.hash]);
  const kb = Math.max(1, Math.round(att.bytes / 1024));
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`msg-thumb ${url ? "" : "loading"} ${failed ? "failed" : ""}`}
        onClick={() => url && setBig(true)}
        disabled={failed}
        title={failed ? t("The image is no longer stored.") : `${att.mediaType} · ${kb} KB`}
        aria-label={t("Enlarge image")}
        data-testid="Message image"
      >
        {url ? <img src={url} alt="" draggable={false} /> : <span className="thumb-ph" aria-hidden="true">{failed ? "!" : ""}</span>}
      </button>
      {big && url && <ImageViewer url={url} name={`${att.mediaType} · ${kb} KB`} onClose={() => setBig(false)} />}
    </>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(id);
  }, [copied]);
  return (
    <button
      type="button"
      className="msg-action"
      onClick={() => {
        void window.rg.copyText(text);
        setCopied(true);
      }}
      title={t("Copy the message")}
      data-testid="Copy message"
    >
      {copied ? t("Copied") : t("Copy")}
    </button>
  );
}

export function UserMessage({ item }: { item: UserItem }) {
  const state = useStore((s) => s.state);
  const openDialog = useStore((s) => s.openDialog);
  const changed = state.changedFiles;
  const revealFile = useStore((s) => s.revealFile);
  const [editing, setEditing] = useState(false);
  const avail = rewindAvailability(state, item.turn);
  const editBlocked = avail.busy ?? (avail.conversation.ok ? null : avail.conversation.why);
  const conv = avail.conversation;
  const rewindBlocked = avail.busy ?? (conv.ok || avail.files.ok ? null : conv.why);

  if (editing) return <EditRetry item={item} onClose={() => setEditing(false)} />;

  return (
    <div className="user-row" data-testid="User row">
      <div className="msg-actions" role="toolbar" aria-label={t("Message actions")} data-find-skip="">
        <CopyButton text={item.text} />
        <button type="button" className="msg-action" disabled={editBlocked !== null} title={editBlocked ?? t("Edit this message and send it again from this point")} onClick={() => setEditing(true)} data-testid="Edit and resend">
          {t("Edit & resend")}
        </button>
        <button
          type="button"
          className="msg-action"
          disabled={rewindBlocked !== null || typeof item.turn !== "number"}
          title={rewindBlocked ?? t("Rewind the conversation and / or Claude's file changes to just before this message")}
          onClick={() => typeof item.turn === "number" && openDialog({ kind: "rewind", turn: item.turn })}
          data-testid="Rewind here"
        >
          {t("Rewind to here")}
        </button>
      </div>
      <div className="msg user" data-testid="User message">
        {item.text}
        {item.mentions && item.mentions.length > 0 && (
          <div className="msg-mentions">
            {item.mentions.map((p) => (
              <MentionChip key={p} path={p} changed={changed.some((f) => f.path === p)} onOpen={changed.some((f) => f.path === p) ? () => revealFile(p) : undefined} />
            ))}
          </div>
        )}
        {item.attachments && item.attachments.length > 0 && (
          <div className="msg-images">
            {item.attachments.map((a, i) => (
              <AttachmentThumb key={`${a.hash}-${i}`} att={a} />
            ))}
          </div>
        )}
      </div>
      <AutoModelSwitchLine choice={item.autoModel} />{/* MARK: wave5 w5-model */}
    </div>
  );
}

/** "수정해서 다시 보내기": the message's text, mentions and images, editable; sent with `rewind {editText}`. */
function EditRetry({ item, onClose }: { item: UserItem; onClose: () => void }) {
  const state = useStore((s) => s.state);
  const avail = rewindAvailability(state, item.turn);
  const [text, setText] = useState(item.text);
  const [mentions, setMentions] = useState<string[]>(item.mentions ?? []);
  const [images, setImages] = useState<DraftImage[]>([]);
  const [imagesLoading, setImagesLoading] = useState((item.attachments?.length ?? 0) > 0);
  const [imageError, setImageError] = useState<string | null>(null);
  const [restoreFiles, setRestoreFiles] = useState(avail.files.ok && (avail.checkpoint?.filesSince ?? 0) > 0);
  const { run, busy, refusal, forceDialog } = useRewindRun(onClose);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (el) {
      el.focus();
      el.selectionStart = el.selectionEnd = el.value.length;
    }
  }, []);
  // The original images, fetched once so they go out again (removable like any chip).
  useEffect(() => {
    const atts = item.attachments ?? [];
    if (atts.length === 0) return;
    let live = true;
    Promise.all(atts.map((a, i) => attachmentData(a.hash).then((d) => storedToDraft(t("Image {0}", i + 1), { kind: "image", mediaType: d.mediaType, dataBase64: d.dataBase64 }, a.bytes))))
      .then((list) => live && setImages(list))
      .catch(() => live && setImageError(t("Some of the original images are no longer stored — they will not be sent again.")))
      .finally(() => live && setImagesLoading(false));
    return () => {
      live = false;
    };
  }, [item.attachments]);

  const mode = editRetryMode(avail, restoreFiles);
  const blocked = avail.busy ?? (avail.conversation.ok ? null : avail.conversation.why);
  const canSubmit = !busy && !imagesLoading && blocked === null && text.trim().length > 0 && typeof item.turn === "number";
  const submit = () => {
    if (!canSubmit || typeof item.turn !== "number") return;
    void run({ toTurn: item.turn, mode, editText: text, mentions: addMentions([], mentions).list, attachments: images.map((i) => i.attachment) });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isEnter(e) && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (!busy) onClose();
    }
  };
  const filesSince = avail.checkpoint?.filesSince ?? 0;

  return (
    <div className="user-row editing" data-testid="Edit retry">
      <div className="user-edit">
        <div className="edit-head">
          <span className="bold">{t("Edit & resend")}</span>
          <span className="faint tiny">{t("The conversation goes back to just before this message; the current chat stays in the history.")}</span>
        </div>
        <DraftChips mentions={mentions} images={images} onRemoveMention={(p) => setMentions((m) => m.filter((x) => x !== p))} onRemoveImage={(id) => setImages((l) => l.filter((i) => i.id !== id))} />
        {imagesLoading && <span className="caption muted">{t("Loading the original images…")}</span>}
        {imageError && <span className="caption orange">{imageError}</span>}
        <textarea ref={boxRef} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} disabled={busy} rows={Math.min(8, Math.max(2, text.split("\n").length))} data-testid="Edit retry input" />
        <label className={`edit-files ${avail.files.ok ? "" : "disabled"}`} title={avail.files.ok ? undefined : avail.files.why}>
          <input type="checkbox" checked={restoreFiles && avail.files.ok} disabled={!avail.files.ok || busy} onChange={(e) => setRestoreFiles(e.target.checked)} data-testid="Edit retry files" />
          <span>{filesSince > 0 ? t("Also put back Claude's changes to {0} file(s) since this message", filesSince) : t("Also put back Claude's file changes since this message (none)")}</span>
        </label>
        <RewindRefusalNote view={refusal} />
        {blocked && <div className="rewind-refusal busy">{blocked}</div>}
        <div className="edit-actions">
          <span className="faint tiny">{t("⌘↩ send · Esc cancel")}</span>
          <span className="spacer" />
          {busy && <span className="spinner" />}
          <button type="button" onClick={onClose} disabled={busy} data-testid="Edit retry cancel">{t("Cancel")}</button>
          <button type="button" className="primary" disabled={!canSubmit} onClick={submit} data-testid="Edit retry send">
            {t("Resend")}
          </button>
        </div>
      </div>
      {forceDialog}
    </div>
  );
}
