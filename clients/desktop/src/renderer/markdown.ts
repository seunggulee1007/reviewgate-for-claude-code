/**
 * Assistant-text Markdown (docs/M16-FRICTION.md): `marked` → DOMPurify. Raw HTML in the source is
 * never passed through (rendered as escaped text); fenced code becomes a `.codeblock` with a language
 * label and a Copy button; links keep `href` only (the component opens http(s) ones externally).
 */
import DOMPurify, { type Config } from "dompurify";
import { Marked, type Tokens } from "marked";
import { t } from "./i18n";

function escapeHTML(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    // No raw HTML passthrough: `<b>x</b>` in the text stays visible as text.
    html({ text }: Tokens.HTML | Tokens.Tag): string {
      return escapeHTML(text);
    },
    code({ text, lang }: Tokens.Code): string {
      const label = (lang ?? "").trim().split(/\s+/)[0] ?? "";
      return (
        `<div class="codeblock">` +
        `<div class="codehead"><span class="lang">${escapeHTML(label || t("code"))}</span>` +
        `<button type="button" class="copy" data-copy="1">${escapeHTML(t("Copy"))}</button></div>` +
        `<pre><code${label ? ` class="language-${escapeHTML(label)}"` : ""}>${escapeHTML(text)}\n</code></pre></div>`
      );
    },
  },
});

const PURIFY: Config = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["style", "img", "svg", "math", "form", "input", "iframe"],
  FORBID_ATTR: ["style", "target", "onclick"],
  ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
};

/** Safe HTML for one assistant message. */
export function renderMarkdown(text: string): string {
  const html = md.parse(text, { async: false });
  return DOMPurify.sanitize(html, PURIFY);
}
