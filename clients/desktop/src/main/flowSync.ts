/**
 * MARK: wave3 desktop-flow
 * docs/PROTOCOL.md §36.11 / §36.12 in main, pure (no `electron`) and unit-tested: the window's engine gets its
 * repository's `commitTemplate` and `workbenchSetup` (src/shared/flowSettings.ts) whenever the repository the window shows
 * changes (a project open / switch, the workbench list naming the main worktree) and whenever the user edits them
 * (`rg:setSettings` → `resyncFlowSettings`, before the call returns — so a `commit_draft` / `workbench_preview` the renderer
 * sends next comes after it). Only a change is sent; `set_settings` merges, so the rest of the engine's settings stay.
 */
import type { Settings } from "@reviewgate/engine";
import { flowEngineSettings, flowRepoRoot, type FlowSettingsMaps, type FlowStateLike } from "../shared/flowSettings.js";

/** The part of a `ReviewEngine` this needs. */
export type FlowSettingsSink = { handle(cmd: { type: "set_settings"; settings: Partial<Settings> }): unknown };

/** Per engine: the repository last seen and what was last sent for it. */
const sent = new WeakMap<object, { root: string | null; key: string | null }>();

function push(engine: FlowSettingsSink, root: string | null, settings: FlowSettingsMaps): boolean {
  const flow = flowEngineSettings(settings, root);
  const key = flow ? JSON.stringify(flow) : null;
  const last = sent.get(engine);
  sent.set(engine, { root, key: key ?? last?.key ?? null });
  if (!flow || key === last?.key) return false;
  void engine.handle({ type: "set_settings", settings: flow });
  return true;
}

/** A state snapshot of `engine`: sends the flow settings when its repository (or what they hold) changed. True when sent. */
export function syncFlowSettings(engine: FlowSettingsSink, state: FlowStateLike, settings: FlowSettingsMaps): boolean {
  return push(engine, flowRepoRoot(state), settings);
}

/** The settings changed: sends the flow settings of the repository `engine` last showed when they differ. True when sent. */
export function resyncFlowSettings(engine: FlowSettingsSink, settings: FlowSettingsMaps): boolean {
  return push(engine, sent.get(engine)?.root ?? null, settings);
}
