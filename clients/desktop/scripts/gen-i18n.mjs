// Regenerates src/renderer/i18n/ko.json from the Mac app's App/ + Core/ Localizable.xcstrings (+ ko.extra.json): same English keys,
// Swift format specifiers (%lld, %@, %1$@) rewritten as {0}, {1}, … so `t()` can substitute them.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sources = [
  fileURLToPath(new URL("../../../App/Localizable.xcstrings", import.meta.url)),
  fileURLToPath(new URL("../../../Core/Sources/ReviewGateCore/Resources/Localizable.xcstrings", import.meta.url)),
];
/** Strings used only by the desktop client (no Mac counterpart); merged last, wins over xcstrings. */
const extra = fileURLToPath(new URL("../src/renderer/i18n/ko.extra.json", import.meta.url));
const out = fileURLToPath(new URL("../src/renderer/i18n/ko.json", import.meta.url));

function convert(s) {
  let i = 0;
  return s.replace(/%(\d+)\$(?:lld|d|@|s)|%(?:lld|d|@|s|\.\d+f)|%%/g, (m, pos) => {
    if (m === "%%") return "%";
    if (pos !== undefined) return `{${Number(pos) - 1}}`;
    return `{${i++}}`;
  });
}

const ko = {};
for (const src of sources) {
  const doc = JSON.parse(readFileSync(src, "utf8"));
  for (const [key, entry] of Object.entries(doc.strings)) {
    const v = entry?.localizations?.ko?.stringUnit?.value;
    if (!key || !v) continue;
    const k = convert(key);
    const t = convert(v);
    if (k !== t) ko[k] = t;
  }
}
if (existsSync(extra)) Object.assign(ko, JSON.parse(readFileSync(extra, "utf8")));
writeFileSync(out, JSON.stringify(ko, Object.keys(ko).sort(), 2) + "\n");
console.log(`${Object.keys(ko).length} ko strings → ${out}`);
