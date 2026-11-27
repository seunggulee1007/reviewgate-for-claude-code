import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

describe("§72.2 the styles (pure)", () => {
  it("reads a style file's name and description from its frontmatter", () => {
    expect(styleFrontmatter("---\nname: Diagrams first\ndescription: \"Lead with a diagram\"\nkeep-coding-instructions: true\n---\nBody")).toEqual({ name: "Diagrams first", description: "Lead with a diagram" });
    expect(styleFrontmatter("no frontmatter")).toEqual({});
  });

  it("walks .claude/output-styles from the folder up to the repository, closest first", () => {
    expect(projectStyleDirs("/work/acme/app/web", "/work/acme")).toEqual([
      "/work/acme/app/web/.claude/output-styles", "/work/acme/app/.claude/output-styles", "/work/acme/.claude/output-styles",
    ]);
  });

  it("explains the CLI's names: built-ins first, then each file's source and description", () => {
    const files: Record<string, string> = {
      "/work/acme/.claude/output-styles/review.md": "---\ndescription: Short reviews\n---\n",
      "/Users/dev/.claude/output-styles/diagrams.md": "---\nname: Diagrams first\ndescription: Lead with a diagram\n---\n",
      "/plugins/teach/output-styles/tutor.md": "---\ndescription: Step by step\n---\n",
    };
    const list = (d: string) => Object.keys(files).filter((p) => p.startsWith(`${d}/`)).map((p) => p.slice(d.length + 1));
    const styles = listOutputStyles({
      available: ["Diagrams first", "default", "Explanatory", "review", "tutor", "Mystery", "Learning", "Concise", "Proactive"],
      configDir: "/Users/dev/.claude", cwd: "/work/acme", root: "/work/acme", plugins: [{ name: "teach", path: "/plugins/teach" }], managedDir: null,
      read: (p) => files[p] ?? null, list,
    });
    expect(styles).toEqual([
      { name: "default", description: null, source: "builtin" },
      { name: "Proactive", description: null, source: "builtin" },
      { name: "Concise", description: null, source: "builtin" },
      { name: "Explanatory", description: null, source: "builtin" },
      { name: "Learning", description: null, source: "builtin" },
      { name: "Diagrams first", description: "Lead with a diagram", source: "user", path: "/Users/dev/.claude/output-styles/diagrams.md" },
      { name: "review", description: "Short reviews", source: "project", path: "/work/acme/.claude/output-styles/review.md" },
      { name: "tutor", description: "Step by step", source: "plugin", path: "/plugins/teach/output-styles/tutor.md", plugin: "teach" },
      { name: "Mystery", description: null, source: "other" },
    ]);
  });

  it("finds the file whose outputStyle applies: managed, local, project, user", () => {
    const read = (m: Record<string, unknown>) => (p: string) => (p in m ? JSON.stringify(m[p]) : null);
    const base = { configDir: "/Users/dev/.claude", cwd: "/work/acme", loadUser: true, loadLocal: true, managed: null, managedPath: null };
    const all = { "/Users/dev/.claude/settings.json": { outputStyle: "Concise" }, "/work/acme/.claude/settings.json": { outputStyle: "Learning" }, "/work/acme/.claude/settings.local.json": { outputStyle: "Explanatory" } };
    expect(outputStyleSetIn({ ...base, read: read(all) })).toEqual({ source: "local", path: "/work/acme/.claude/settings.local.json", value: "Explanatory" });
    expect(outputStyleSetIn({ ...base, loadLocal: false, read: read(all) })?.source).toBe("project");
    expect(outputStyleSetIn({ ...base, read: read({ "/Users/dev/.claude/settings.json": { outputStyle: "Concise" } }) })?.source).toBe("user");
    expect(outputStyleSetIn({ ...base, loadUser: false, read: read({ "/Users/dev/.claude/settings.json": { outputStyle: "Concise" } }) })).toBeNull();
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
