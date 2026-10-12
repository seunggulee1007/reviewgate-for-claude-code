/**
 * MARK: wave4c w4c-review — docs/PROTOCOL.md §41.3: a changed png / jpg / gif before and after (`file_image`, each side ≤ 2 MB),
 * side by side on a checkerboard so a transparent or dark image shows on the dark theme too. A side over 2 MB says so; an
 * added / deleted image has one side. Shown above the binary file's sizes line; an older engine (`unknown_command`) shows
 * nothing new.
 */
import { useEffect, useState } from "react";
import type { ChangedFileState, FileImageEvent } from "@reviewgate/engine";
import { engineRequest, refusalOf } from "../../engineRequest";
import { t } from "../../i18n";
import { imageSrc } from "../../reviewLeftovers";
import "./reviewLeftovers.css";

export function ImagePreview(props: { file: ChangedFileState; tree: string | null }) {
  const { file } = props;
  const key = `${props.tree ?? ""}\u0000${file.path}`;
  const [box, setBox] = useState<{ key: string; reply: FileImageEvent | null; failed: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    setBox({ key, reply: null, failed: false });
    engineRequest({ type: "file_image", path: file.path })
      .then((reply) => live && setBox({ key, reply, failed: false }))
      .catch((e: unknown) => {
        // An engine before §41.3: no preview, nothing to say (the sizes line stays).
        if (live) setBox({ key, reply: null, failed: refusalOf(e).code !== "unknown_command" });
      });
    return () => {
      live = false;
    };
  }, [key, file.path]);
  const cur = box && box.key === key ? box : null;
  if (!cur || (!cur.reply && !cur.failed)) return null;
  if (!cur.reply) return <div className="caption muted image-preview-note" data-testid="Image preview failed">{t("Could not load the image preview")}</div>;
  const r = cur.reply;
  return (
    <div className="image-preview" data-testid="Image preview">
      <ImageSide label={t("Before")} side={imageSrc(r.old, r.mediaType)} empty={t("Added in this review")} />
      <ImageSide label={t("After")} side={imageSrc(r.new, r.mediaType)} empty={t("Deleted in this review")} />
    </div>
  );
}

function ImageSide(props: { label: string; side: { src: string } | { reason: string } | null; empty: string }) {
  const { side } = props;
  return (
    <figure className="image-preview-side">
      <figcaption className="caption muted">{props.label}</figcaption>
      <div className="image-preview-frame">
        {side === null ? (
          <span className="caption muted">{props.empty}</span>
        ) : "src" in side ? (
          <img src={side.src} alt={props.label} />
        ) : (
          <span className="caption muted">{side.reason}</span>
        )}
      </div>
    </figure>
  );
}
