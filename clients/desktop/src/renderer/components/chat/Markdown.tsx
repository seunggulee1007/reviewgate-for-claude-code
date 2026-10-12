/**
 * Rendered assistant message (M16): `renderMarkdown` output with click delegation — links open through
 * `window.rg.openExternal` (http(s) only, never in-window navigation), the code-block Copy button copies
 * the block's text and shows "Copied" for 1.5 s.
 */
import { useMemo, type MouseEvent } from "react";
import { t } from "../../i18n";
import { renderMarkdown } from "../../markdown";

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const link = target.closest("a[href]");
    if (link) {
      e.preventDefault();
      const href = link.getAttribute("href") ?? "";
      if (/^https?:\/\//i.test(href)) void window.rg.openExternal(href);
      return;
    }
    const copy = target.closest<HTMLButtonElement>("button.copy");
    if (!copy) return;
    const code = copy.closest(".codeblock")?.querySelector("code")?.textContent ?? "";
    void navigator.clipboard.writeText(code.replace(/\n$/, "")).then(() => {
      copy.textContent = t("Copied");
      setTimeout(() => {
        copy.textContent = t("Copy");
      }, 1500);
    });
  };
  // Sanitized by DOMPurify in renderMarkdown; raw HTML from the model is escaped, not rendered.
  return <div className="markdown" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
