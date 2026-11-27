import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalStyle, listOutputStyles, outputStyleSetIn, projectStyleDirs, styleFrontmatter } from "../src/session/outputStyles.js";
import { NO_MANAGED_POLICY } from "../src/statusline/managed.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §72.2: `/output-style` — the styles, the current one, and switching it as the terminal does. */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});
const temp = (name: string): string => {
  const d = realpathSync(makeTempDir(name));
  dirs.push(d);
  return d;
};

/** The same logic on POSIX and Windows path rules, whatever the host (a Windows runner has no `/work/acme`). */
const LAYOUTS = [
  { name: "posix", pa: path.posix, cfg: "/Users/dev/.claude", root: "/work/acme", plug: "/plugins" },
  { name: "win32", pa: path.win32, cfg: "C:\\Users\\dev\\.claude", root: "C:\\work\\acme", plug: "C:\\plugins" },
];

describe("§72.2 the styles (pure)", () => {
  it("reads a style file's name and description from its frontmatter", () => {
    expect(styleFrontmatter("---\nname: Diagrams first\ndescription: \"Lead with a diagram\"\nkeep-coding-instructions: true\n---\nBody")).toEqual({ name: "Diagrams first", description: "Lead with a diagram" });
    expect(styleFrontmatter("no frontmatter")).toEqual({});
  });

  it.each(LAYOUTS)("walks .claude/output-styles from the folder up to the repository, closest first ($name paths)", ({ pa, root }) => {
    const at = pa.join;
    expect(projectStyleDirs(at(root, "app", "web"), root, pa)).toEqual([at(root, "app", "web", ".claude", "output-styles"), at(root, "app", ".claude", "output-styles"), at(root, ".claude", "output-styles")]);
    expect(projectStyleDirs(root, root, pa)).toEqual([at(root, ".claude", "output-styles")]);
  });

  it("stops at the repository whatever the case of a Windows drive or folder, and at the drive root", () => {
    expect(projectStyleDirs("c:\\work\\acme\\app", "C:\\Work\\Acme", path.win32)).toEqual(["c:\\work\\acme\\app\\.claude\\output-styles", "c:\\work\\acme\\.claude\\output-styles"]);
    expect(projectStyleDirs("C:\\work\\acme", "D:\\other", path.win32)).toEqual(["C:\\work\\acme\\.claude\\output-styles", "C:\\work\\.claude\\output-styles", "C:\\.claude\\output-styles"]);
    // POSIX paths stay case-sensitive.
    expect(projectStyleDirs("/work/Acme/app", "/work/acme", path.posix).at(-1)).toBe("/.claude/output-styles");
  });

  it.each(LAYOUTS)("explains the CLI's names: built-ins first, then each file's source and description ($name paths)", ({ pa, cfg, root, plug }) => {
    const at = pa.join;
    const files: Record<string, string> = {
      [at(root, ".claude", "output-styles", "review.md")]: "---\ndescription: Short reviews\n---\n",
      [at(cfg, "output-styles", "diagrams.md")]: "---\nname: Diagrams first\ndescription: Lead with a diagram\n---\n",
      [at(plug, "teach", "output-styles", "tutor.md")]: "---\ndescription: Step by step\n---\n",
    };
    const list = (d: string) => Object.keys(files).filter((p) => pa.dirname(p) === d).map((p) => pa.basename(p));
    const styles = listOutputStyles({
      available: ["Diagrams first", "default", "Explanatory", "review", "tutor", "Mystery", "Learning", "Concise", "Proactive"],
      configDir: cfg, cwd: root, root, plugins: [{ name: "teach", path: at(plug, "teach") }], managedDir: null,
      read: (p) => files[p] ?? null, list, pathApi: pa,
    });
    expect(styles).toEqual([
      { name: "default", description: null, source: "builtin" },
      { name: "Proactive", description: null, source: "builtin" },
      { name: "Concise", description: null, source: "builtin" },
      { name: "Explanatory", description: null, source: "builtin" },
      { name: "Learning", description: null, source: "builtin" },
      { name: "Diagrams first", description: "Lead with a diagram", source: "user", path: at(cfg, "output-styles", "diagrams.md") },
      { name: "review", description: "Short reviews", source: "project", path: at(root, ".claude", "output-styles", "review.md") },
      { name: "tutor", description: "Step by step", source: "plugin", path: at(plug, "teach", "output-styles", "tutor.md"), plugin: "teach" },
      { name: "Mystery", description: null, source: "other" },
    ]);
  });

  it.each(LAYOUTS)("finds the file whose outputStyle applies: managed, local, project, user ($name paths)", ({ pa, cfg, root }) => {
    const at = pa.join;
    const read = (m: Record<string, unknown>) => (p: string) => (p in m ? JSON.stringify(m[p]) : null);
    const base = { configDir: cfg, cwd: root, loadUser: true, loadLocal: true, managed: null, managedPath: null, pathApi: pa };
    const user = at(cfg, "settings.json");
    const project = at(root, ".claude", "settings.json");
    const local = at(root, ".claude", "settings.local.json");
    const all = { [user]: { outputStyle: "Concise" }, [project]: { outputStyle: "Learning" }, [local]: { outputStyle: "Explanatory" } };
    expect(outputStyleSetIn({ ...base, read: read(all) })).toEqual({ source: "local", path: local, value: "Explanatory" });
    expect(outputStyleSetIn({ ...base, loadLocal: false, read: read(all) })?.source).toBe("project");
    expect(outputStyleSetIn({ ...base, read: read({ [user]: { outputStyle: "Concise" } }) })?.source).toBe("user");
    expect(outputStyleSetIn({ ...base, loadUser: false, read: read({ [user]: { outputStyle: "Concise" } }) })).toBeNull();
    expect(outputStyleSetIn({ ...base, managed: { outputStyle: "Concise" }, managedPath: "/m.json", read: read(all) })).toEqual({ source: "managed", path: "/m.json", value: "Concise" });
  });

  it("takes a name without case, as /output-style does", () => {
    expect(canonicalStyle("concise", ["default", "Concise"])).toBe("Concise");
    expect(canonicalStyle(" Concise ", ["default", "Concise"])).toBe("Concise");
    expect(canonicalStyle("nope", ["default"])).toBeNull();
  });
});

function makeRepo(): string {
  const repo = temp("rg-style-repo");
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "test@example.com");
  sh(repo, "config", "user.name", "Test");
  write(repo, "a.txt", "a\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "init");
  return repo;
}

describe("§72.2 output_styles / output_style_set", () => {
  async function setup(settings: Record<string, unknown> = {}) {
    const cfg = join(temp("rg-style"), "claude-config");
    mkdirSync(join(cfg, "output-styles"), { recursive: true });
    writeFileSync(join(cfg, "output-styles", "pirate.md"), "---\ndescription: Talk like a pirate\n---\nArr.");
    const repo = makeRepo();
    const h = makeHarness({ env: { CLAUDE_CONFIG_DIR: cfg }, managedPolicy: () => NO_MANAGED_POLICY });
    harnesses.push(h);
    await h.hello({ loadUserSettings: true, ...settings });
    await h.open(repo);
    return { h, cfg, repo };
  }

  it("no session reported yet: the built-ins and the files, current null, cannot set", async () => {
    const { h } = await setup();
    const r = await h.engine.request({ type: "output_styles" });
    expect(r.current).toBeNull();
    expect(r.canSet).toBe(false);
    expect(r.why).toBe("no_session");
    expect(r.styles.map((s) => s.name)).toEqual(["default", "Proactive", "Concise", "Explanatory", "Learning", "pirate"]);
    expect(h.engine.state.session.outputStyle).toBeNull();
    await expect(h.engine.request({ type: "output_style_set", name: "Concise" })).rejects.toThrow("no_session");
  });

  it("the session's style is in the state; a set goes through the CLI's writer, without case", async () => {
    const { h } = await setup();
    h.session().emit({ type: "output_style_info", current: "default", available: ["default", "Proactive", "Concise", "Explanatory", "Learning", "pirate"] });
    await h.waitFor((s) => s.session.outputStyle === "default", "the session's style");
    const r = await h.engine.request({ type: "output_styles" });
    expect(r.canSet).toBe(true);
    expect(r.current).toBe("default");
    expect(r.styles.find((s) => s.name === "pirate")).toMatchObject({ source: "user", description: "Talk like a pirate" });

    const set = await h.engine.request({ type: "output_style_set", name: "concise" });
    expect(h.session().outputStyleSets).toEqual(["Concise"]);
    expect(set.current).toBe("Concise");
    expect(h.engine.state.session.outputStyle).toBe("Concise");

    await expect(h.engine.request({ type: "output_style_set", name: "Nope" })).rejects.toThrow("unknown_output_style:Nope");
    h.session().outputStyleFailure = new Error("refused: remote transport");
    await expect(h.engine.request({ type: "output_style_set", name: "Learning" })).rejects.toThrow("output_style_failed:refused: remote transport");
    expect(h.engine.state.session.outputStyle).toBe("Concise");
  });

  it("without local settings the CLI cannot write the style: refused with the reason", async () => {
    const { h } = await setup({ loadLocalSettings: false });
    h.session().emit({ type: "output_style_info", current: "Concise", available: ["default", "Concise"] });
    await h.waitFor((s) => s.session.outputStyle === "Concise", "the session's style");
    const r = await h.engine.request({ type: "output_styles" });
    expect(r.why).toBe("local_settings_off");
    await expect(h.engine.request({ type: "output_style_set", name: "default" })).rejects.toThrow("local_settings_off");
  });
});
