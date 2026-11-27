import type { MarketplaceInfo, PluginAction, PluginAvailable, PluginInstalled, PluginsReloadedEvent } from "../protocol.js";
import { CommandRefused } from "../errors.js";
import { wellFormed } from "../util/safeRead.js";

/**
 * docs/PROTOCOL.md §72.3 `/plugin`: the terminal's plugin panel through the CLI's own non-interactive commands — `claude
 * plugin list --json --available`, `claude plugin marketplace list --json`, and `claude plugin install | uninstall |
 * enable | disable | update` / `claude plugin marketplace add | remove | update` with `--json` (the plugin commands
 * reference, 2026-11). Pure argv builders and parsers; the engine runs them without a shell.
 */

export const PLUGIN_ACTIONS: readonly PluginAction[] = ["install", "uninstall", "enable", "disable", "update", "marketplace_add", "marketplace_remove", "marketplace_update"];
/** What the reply's `output` keeps of stdout + stderr. */
export const PLUGIN_OUTPUT_MAX = 8 * 1024;
/** A target longer than this is refused (a plugin id, a marketplace name or source). */
const TARGET_MAX = 500;

/** Actions that fetch from the network (a clone, a download): the longer timeout. */
export function pluginActionTimeoutMs(action: PluginAction): number {
  return action === "install" || action === "update" || action === "marketplace_add" || action === "marketplace_update" ? 180_000 : 30_000;
}

/** `plugin_run`'s argv for `claude`, or a refusal: an unknown action, a target that is empty, a flag or not one line. */
export function pluginRunArgs(action: unknown, target: unknown, scope: unknown): string[] {
  if (typeof action !== "string" || !(PLUGIN_ACTIONS as readonly string[]).includes(action)) throw new CommandRefused("invalid_plugin_action");
  const t = typeof target === "string" ? target.trim() : "";
  if (!t || t.length > TARGET_MAX || t.startsWith("-") || /[\r\n\0]/.test(t)) throw new CommandRefused("invalid_plugin_target");
  if (scope !== undefined && scope !== null && scope !== "user" && scope !== "project" && scope !== "local") throw new CommandRefused("invalid_plugin_scope");
  const a = action as PluginAction;
  // `marketplace update` takes no --scope; `update` and `marketplace_remove` take it but default sensibly.
  const scoped = typeof scope === "string" && a !== "marketplace_update" ? (a.startsWith("marketplace_") ? ["--scope", scope] : ["-s", scope]) : [];
  const verb = a.startsWith("marketplace_") ? ["marketplace", a.slice("marketplace_".length)] : [a];
  // The target never starts with "-" (checked above), so it is never read as an option.
  return ["plugin", ...verb, t, ...scoped, "--json"];
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? wellFormed(v) : undefined);
const strs = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => wellFormed(x).slice(0, 500));
  return out.length > 0 ? out : undefined;
};

/** The last line of `stdout` that parses as JSON ("parse only that line", the reference says). */
export function lastJsonLine(stdout: string): unknown {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (!(l.startsWith("{") || l.startsWith("["))) continue;
    try {
      return JSON.parse(l) as unknown;
    } catch {
      /* not JSON: keep looking */
    }
  }
  // A pretty-printed document (`plugin list --json`).
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    return null;
  }
}

/** `claude plugin list --json [--available]`: an array, or `{installed, available}` with `--available`. */
export function parsePluginList(stdout: string, appDisabled: readonly string[]): { installed: PluginInstalled[]; available: PluginAvailable[] } | null {
  const doc = lastJsonLine(stdout);
  const o = obj(doc);
  const rawInstalled = Array.isArray(doc) ? doc : Array.isArray(o?.installed) ? (o!.installed as unknown[]) : null;
  if (!rawInstalled) return null;
  const installed: PluginInstalled[] = [];
  for (const r of rawInstalled) {
    const p = obj(r);
    const id = str(p?.id);
    if (!p || !id) continue;
    const at = id.lastIndexOf("@");
    const entry: PluginInstalled = {
      id,
      name: at > 0 ? id.slice(0, at) : id,
      marketplace: at > 0 ? id.slice(at + 1) : null,
      version: str(p.version) ?? "unknown",
      scope: str(p.scope) ?? "user",
      enabled: p.enabled === true,
    };
    const installPath = str(p.installPath) ?? str(p.readFromFolder);
    if (installPath) entry.installPath = installPath;
    const projectPath = str(p.projectPath);
    if (projectPath) entry.projectPath = projectPath;
    const errors = strs(p.errors);
    if (errors) entry.errors = errors;
    const notes = strs(p.notes);
    if (notes) entry.notes = notes;
    if (appDisabled.includes(id)) entry.appOff = true;
    installed.push(entry);
  }
  const available: PluginAvailable[] = [];
  for (const r of Array.isArray(o?.available) ? (o!.available as unknown[]) : []) {
    const p = obj(r);
    const id = str(p?.pluginId);
    if (!p || !id) continue;
    const at = id.lastIndexOf("@");
    const entry: PluginAvailable = { id, name: str(p.name) ?? (at > 0 ? id.slice(0, at) : id), marketplace: str(p.marketplaceName) ?? (at > 0 ? id.slice(at + 1) : "") };
    const description = str(p.description);
    if (description) entry.description = description.slice(0, 500);
    const version = str(p.version);
    if (version) entry.version = version;
    if (typeof p.installCount === "number" && Number.isFinite(p.installCount)) entry.installCount = p.installCount;
    available.push(entry);
  }
  return { installed, available };
}

/** `claude plugin marketplace list --json`: one object per marketplace (every field a string). */
export function parseMarketplaces(stdout: string): MarketplaceInfo[] {
  const doc = lastJsonLine(stdout);
  if (!Array.isArray(doc)) return [];
  const out: MarketplaceInfo[] = [];
  for (const r of doc) {
    const m = obj(r);
    const name = str(m?.name);
    if (!m || !name) continue;
    const entry: MarketplaceInfo = { name, source: str(m.source) ?? "unknown" };
    for (const k of ["repo", "url", "path", "ref", "installLocation"] as const) {
      const v = str(m[k]);
      if (v) entry[k] = v;
    }
    out.push(entry);
  }
  return out;
}

/**
 * The outcome of one `plugin_run`: the `--json` result line's `outcome` / `message` (an enable or disable that is
 * already so counts as done, as the reference suggests), else the exit status and the first line of what it printed.
 */
export function pluginRunOutcome(out: { status: number | null; stdout: string; stderr: string }): { ok: boolean; message: string; output: string } {
  const result = obj(lastJsonLine(out.stdout));
  const text = [out.stdout.trim(), out.stderr.trim()].filter(Boolean).join("\n");
  const output = wellFormed(text.length > PLUGIN_OUTPUT_MAX ? `…${text.slice(text.length - PLUGIN_OUTPUT_MAX + 1)}` : text);
  if (result && (result.outcome === "ok" || result.outcome === "failed")) {
    const ok = result.outcome === "ok" || result.alreadyInGoalState === true;
    return { ok, message: str(result.message) ?? (ok ? "done" : `exit ${out.status}`), output };
  }
  const first = (s: string) => (s.split(/\r?\n/).find((l) => l.trim()) ?? "").trim().slice(0, 300);
  const ok = out.status === 0;
  return { ok, message: first(ok ? out.stdout : out.stderr) || first(out.stdout) || (ok ? "done" : `exit ${out.status}`), output };
}

/** The reload's summary line, as the terminal's `Reloaded: N plugins · N skills · N agents · N hooks …`. */
export function reloadCounts(r: { commands: unknown; plugins: { name: string }[]; agents: number; mcpServers: string[]; errorCount: number }, hooks: number): Omit<PluginsReloadedEvent, "type" | "id" | "applied" | "held" | "cacheImpact"> {
  const names = new Set(r.plugins.map((p) => p.name));
  const commands = Array.isArray(r.commands) ? r.commands : [];
  const skills = commands.filter((c) => {
    const name = obj(c)?.name;
    if (typeof name !== "string") return false;
    const i = name.indexOf(":");
    return i > 0 && names.has(name.slice(0, i));
  }).length;
  return {
    plugins: r.plugins.length,
    skills,
    agents: r.agents,
    hooks,
    mcpServers: r.mcpServers.filter((s) => s.startsWith("plugin:")).length,
    errors: r.errorCount,
  };
}
