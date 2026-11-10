/**
 * MARK: wave4b w4b-files — docs/PROTOCOL.md §40.2 (comp-14): the review list "묶기" — none / by folder / by layer
 * (controller · service · mapper · resources · webapp · test, a Spring project's web → service → SQL flow) — and the
 * row path without the source root and the app's root package ("…/orders/billing/InvoiceServiceImpl.java"). Client rule, the same
 * as Core `FileGroups` (Mac). Sections keep the incoming order (git or risky first) and the keyboard order follows them
 * (`displayOrder`); the choice is kept per project (this viewer's localStorage). A bulk list (§39.1) folds by folder instead.
 */
import { create } from "zustand";
import { t } from "./i18n";

/** MARK: wave4c w4c-review — §41.3 "cause": the subagent · Bash command · turn that made the change (`fileCause`). */
export type GroupBy = "none" | "folder" | "layer" | "cause";
export const GROUP_BYS: GroupBy[] = ["none", "folder", "layer", "cause"];

export type FileLayer = "controller" | "service" | "mapper" | "resources" | "webapp" | "test" | "other";
export const LAYER_ORDER: FileLayer[] = ["controller", "service", "mapper", "resources", "webapp", "test", "other"];

const TEST_DIR = /(^|\/)(__tests__|__mocks__|tests?|specs?|e2e|[^/]*tests)\//i;
const TEST_NAME = /[._-](test|spec)\.[A-Za-z0-9]+$|_(test|spec)\.[A-Za-z0-9]+$|(^|\/)test_[^/]+$|(Tests?|IT)\.(swift|kt|kts|java|cs|scala|groovy)$/;
const MAPPER = /(^|\/)(mappers?|sqlmaps?|dao|repository)\/|(Mapper|Dao|Repository)\.(xml|java|kt)$/i;
const CONTROLLER = /(^|\/)controllers?\/|(Controller|Resource|Endpoint)\.(java|kt)$/;
const SERVICE = /(^|\/)services?\/|(Service|ServiceImpl|Facade)\.(java|kt)$/;
const WEBAPP = /(^|\/)(webapp|static|templates|public)\/|\.(jsp|jspf|tag)$/i;
const RESOURCES = /(^|\/)resources\//;

/** The layer a path belongs to (a test first: `FooControllerTest.java` is a test). */
export function layerOf(path: string): FileLayer {
  if (TEST_DIR.test(path) || TEST_NAME.test(path)) return "test";
  if (MAPPER.test(path)) return "mapper";
  if (CONTROLLER.test(path)) return "controller";
  if (SERVICE.test(path)) return "service";
  if (WEBAPP.test(path)) return "webapp";
  if (RESOURCES.test(path)) return "resources";
  return "other";
}

export function layerLabel(layer: FileLayer): string {
  switch (layer) {
    case "controller":
      return t("Controller");
    case "service":
      return t("Service");
    case "mapper":
      return t("Mapper / SQL");
    case "resources":
      return t("Resources");
    case "webapp":
      return t("Web (JSP / JS)");
    case "test":
      return t("Test");
    case "other":
      return t("Other");
  }
}

export type FileSection<F> = { key: string; files: F[] };

const folderOf = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};

/** The sections of `files`: by folder in the order folders first appear, by layer in `LAYER_ORDER`; empty ones left out. */
export function groupFiles<F extends { path: string }>(files: readonly F[], by: GroupBy, causeOf?: (f: F) => string): FileSection<F>[] {
  if (by === "none") return [{ key: "", files: [...files] }];
  const sections = new Map<string, F[]>();
  if (by === "layer") for (const l of LAYER_ORDER) sections.set(l, []);
  for (const f of files) {
    // MARK: wave4c w4c-review — by cause: in the order the causes first appear (no cause known: one section)
    const key = by === "folder" ? folderOf(f.path) : by === "cause" ? (causeOf?.(f) ?? "") : layerOf(f.path);
    const list = sections.get(key);
    if (list) list.push(f);
    else sections.set(key, [f]);
  }
  return [...sections].filter(([, list]) => list.length > 0).map(([key, list]) => ({ key, files: list }));
}

/** The files in section order — what the list draws and ⌘] / ⌘[ step through. */
export function orderByGroups<F extends { path: string }>(files: readonly F[], by: GroupBy, causeOf?: (f: F) => string): F[] {
  return groupFiles(files, by, causeOf).flatMap((s) => s.files);
}

/** A section's header: the layer, or the folder without its source root ("…/orders/billing"; "" = the project root). */
export function sectionLabel(by: GroupBy, key: string): string {
  if (by === "layer") return layerLabel(key as FileLayer);
  if (by === "cause") return key || t("Main"); // MARK: wave4c w4c-review — the key is the cause's own words
  if (key === "") return t("Project root");
  return compactPath(key);
}

const SOURCE_ROOT = /^(.*?\/)?src\/(main|test)\/(java|kotlin|groovy|scala|resources|webapp)(?:\/(.*))?$/;
const COMPANY = /^(com|org|net|io|kr|jp|dev|co|me|app)$/;

/**
 * A path without its source root and the app's root package, the module kept: "src/main/java/com/acme/orders/billing/X.java" →
 * "…/orders/billing/X.java", "acme-api/src/main/java/com/acme/orders/Api.java" → "acme-api/…/orders/Api.java",
 * "src/main/webapp/WEB-INF/jsp/user/a.jsp" → "…/user/a.jsp". Other paths stay as they are.
 */
export function compactPath(path: string): string {
  const m = SOURCE_ROOT.exec(path);
  if (!m) return path;
  const module = m[1] ?? "";
  const kind = m[3]!;
  let rest = m[4] ?? "";
  if (kind === "webapp") rest = rest.replace(/^WEB-INF\/(jsp|views|tags)\//, "");
  else if (kind !== "resources") {
    const segs = rest.split("/");
    if (segs.length >= 4 && COMPANY.test(segs[0]!)) rest = segs.slice(2).join("/");
  }
  return `${module}…/${rest}`;
}

// ---------------------------------------------------------------- the choice, per project

const KEY = "rg.fileGroupBy";

function load(): Record<string, GroupBy> {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((e): e is [string, GroupBy] => GROUP_BYS.includes(e[1] as GroupBy)));
  } catch {
    return {};
  }
}

function save(map: Record<string, GroupBy>): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(map));
  } catch {
    // A private window / blocked storage: the choice lasts until the window closes.
  }
}

type GroupByState = {
  byProject: Record<string, GroupBy>;
  /** The shown project's root (`""` without one). */
  root: string;
  /** Its grouping — what `displayOrder` follows. */
  current: GroupBy;
  setRoot(root: string): void;
  choose(by: GroupBy): void;
  // MARK: wave4c w4c-review — §41.3: each listed file's cause (`fileCause`, path → section), set by the list for `displayOrder`
  causes: Record<string, string>;
  setCauses(causes: Record<string, string>): void;
};

export const useGroupBy = create<GroupByState>((set) => ({
  byProject: load(),
  root: "",
  current: "none",
  setRoot: (root) => set((s) => (s.root === root ? s : { root, current: s.byProject[root] ?? "none" })),
  choose: (by) =>
    set((s) => {
      const byProject = { ...s.byProject, [s.root]: by };
      save(byProject);
      return { byProject, current: by };
    }),
  causes: {},
  setCauses: (causes) => set({ causes }),
}));

/** MARK: wave4c w4c-review — the cause section of `path` the list shows now ("" before the list drew one). */
export function currentCauseOf(path: string): string {
  return useGroupBy.getState().causes[path] ?? "";
}

/** The grouping the list is drawn with now. */
export function currentGroupBy(): GroupBy {
  return useGroupBy.getState().current;
}

export function groupByLabel(by: GroupBy): string {
  switch (by) {
    case "none":
      return t("No grouping");
    case "folder":
      return t("By folder");
    case "layer":
      return t("By layer");
    case "cause":
      return t("By cause"); // MARK: wave4c w4c-review
  }
}
