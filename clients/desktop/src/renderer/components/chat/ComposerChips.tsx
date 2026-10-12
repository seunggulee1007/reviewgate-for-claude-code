/**
 * The chip row above a composer text box (the main composer and the inline "수정해서 다시 보내기" editor):
 * §23 mention chips (file / folder, the review's changed files marked) and §24 image chips (thumbnail, size,
 * remove; click to enlarge). Also the read-only chips on a transcript user message.
 */
import { useState } from "react";
import { formatBytes } from "../../../shared/attachments";
import type { DraftImage } from "../../composerAttach";
import { t } from "../../i18n";
import { splitMention } from "../../mentions";
import { useStore } from "../../store";
import { Modal } from "../Menu";

/** `changed`: the path is in the current review; `dir`: shown with a trailing slash. */
export function MentionChip(props: { path: string; onRemove?: () => void; onOpen?: () => void; dir?: boolean; changed?: boolean }) {
  const { name, dir } = splitMention(props.path);
  return (
    <span className={`mention-chip ${props.changed ? "changed" : ""}`} title={props.path + (props.changed ? ` — ${t("changed in this review")}` : "")} data-testid="Mention chip">
      <span className="at" aria-hidden="true">@</span>
      {props.onOpen ? (
        <button type="button" className="mention-name plain" onClick={props.onOpen}>
          {dir && <span className="dir">{dir}</span>}
          <span className="name">{name}{props.dir ? "/" : ""}</span>
        </button>
      ) : (
        <span className="mention-name">
          {dir && <span className="dir">{dir}</span>}
          <span className="name">{name}{props.dir ? "/" : ""}</span>
        </span>
      )}
      {props.changed && <span className="changed-dot" aria-hidden="true" />}
      {props.onRemove && (
        <button type="button" className="chip-x" onClick={props.onRemove} aria-label={t("Remove {0}", props.path)} title={t("Remove")} data-testid="Remove mention">
          ×
        </button>
      )}
    </span>
  );
}

export function ImageChip(props: { image: DraftImage; onRemove?: () => void }) {
  const [big, setBig] = useState(false);
  return (
    <span className="image-chip" title={`${props.image.name} · ${formatBytes(props.image.bytes)}`} data-testid="Image chip">
      <button type="button" className="thumb-btn" onClick={() => setBig(true)} aria-label={t("Enlarge {0}", props.image.name)}>
        <img src={props.image.url} alt="" draggable={false} />
      </button>
      <span className="image-meta">
        <span className="image-name truncate">{props.image.name}</span>
        <span className="image-size">{formatBytes(props.image.bytes)}</span>
      </span>
      {props.onRemove && (
        <button type="button" className="chip-x" onClick={props.onRemove} aria-label={t("Remove {0}", props.image.name)} title={t("Remove")} data-testid="Remove image">
          ×
        </button>
      )}
      {big && <ImageViewer url={props.image.url} name={props.image.name} onClose={() => setBig(false)} />}
    </span>
  );
}

/** Click-to-enlarge view of one image. */
export function ImageViewer(props: { url: string; name: string; onClose: () => void }) {
  return (
    <Modal onClose={props.onClose} wide testId="Image viewer">
      <div className="image-viewer">
        <img src={props.url} alt={props.name} />
      </div>
      <div className="actions">
        <span className="caption muted truncate">{props.name}</span>
        <span className="spacer" />
        <button type="button" className="primary" onClick={props.onClose} autoFocus>{t("Close")}</button>
      </div>
    </Modal>
  );
}

/** The chip row of a draft: mentions then images; nothing when both are empty. */
export function DraftChips(props: { mentions: string[]; images: DraftImage[]; dirs?: Record<string, true>; onRemoveMention: (path: string) => void; onRemoveImage: (id: number) => void }) {
  const changed = useStore((s) => s.state.changedFiles);
  if (props.mentions.length === 0 && props.images.length === 0) return null;
  return (
    <div className="draft-chips" data-testid="Draft chips">
      {props.mentions.map((p) => (
        <MentionChip key={p} path={p} dir={props.dirs?.[p] === true} changed={changed.some((f) => f.path === p)} onRemove={() => props.onRemoveMention(p)} />
      ))}
      {props.images.map((img) => (
        <ImageChip key={img.id} image={img} onRemove={() => props.onRemoveImage(img.id)} />
      ))}
    </div>
  );
}
