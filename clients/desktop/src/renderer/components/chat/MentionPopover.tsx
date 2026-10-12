/**
 * The `@` popover above the composer (docs/PROTOCOL.md §23): "@변경된 파일" (every file of the current review) and
 * the `list_files` matches — files of the review first with a badge, directories with a trailing `/`. Keyboard
 * navigation lives in the composer (↑ ↓ Enter/Tab Esc); this only renders and handles the mouse.
 */
import { useEffect, useRef, type MouseEvent } from "react";
import { t } from "../../i18n";
import { mentionLabel, splitMention, type MentionOption } from "../../mentions";

export const CHANGED_SHORTCUT_LABEL = () => t("Changed files");

export function MentionPopover(props: { options: MentionOption[]; selection: number; loading: boolean; error: string | null; query: string; onPick: (o: MentionOption) => void; onHover: (i: number) => void }) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".item.selected")?.scrollIntoView({ block: "nearest" });
  }, [props.selection]);
  return (
    <div className="palette mention-popover" role="listbox" aria-label={t("Mention a file")} data-testid="Mention popover">
      <div className="items" ref={listRef}>
        {props.options.map((o, i) => {
          const selected = i === props.selection;
          const common = {
            role: "option" as const,
            "aria-selected": selected,
            className: `item mention-item ${selected ? "selected" : ""}`,
            onMouseDown: (e: MouseEvent) => {
              e.preventDefault();
              props.onPick(o);
            },
            onMouseEnter: () => props.onHover(i),
          };
          if (o.kind === "changed") {
            return (
              <div key="@changed" {...common} data-testid="Mention changed files">
                <span className="mention-icon changed" aria-hidden="true">±</span>
                <span className="mention-main">
                  <span className="name">@{CHANGED_SHORTCUT_LABEL()}</span>
                  <span className="dir">{t("All {0} files of this review", o.paths.length)}</span>
                </span>
                <span className="badge">{o.paths.length}</span>
              </div>
            );
          }
          const label = mentionLabel(o.item);
          const { name, dir } = splitMention(o.item.path);
          return (
            <div key={label} {...common} title={label} data-testid={`Mention option ${label}`}>
              <span className={`mention-icon ${o.item.kind}`} aria-hidden="true">{o.item.kind === "dir" ? "▣" : "▤"}</span>
              <span className="mention-main">
                <span className="name">{name}{o.item.kind === "dir" ? "/" : ""}</span>
                {dir && <span className="dir truncate">{dir}</span>}
              </span>
              {o.item.changed && <span className="badge changed" title={t("changed in this review")}>{t("changed")}</span>}
            </div>
          );
        })}
        {props.options.length === 0 && (
          <div className="note">{props.error ?? (props.loading ? t("Searching…") : props.query ? t("No file matches @{0}", props.query) : t("No files"))}</div>
        )}
      </div>
      <div className="foot">{t("↑↓ choose · ↩ / Tab add · Esc close")}{props.loading && props.options.length > 0 ? ` · ${t("Searching…")}` : ""}</div>
    </div>
  );
}
