import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { isPermissionMode, MAX_PLAN_BYTES, type PermissionMode } from "../protocol.js";
import { writeAtomicJSON } from "./persist.js";

/**
 * MARK: wave4d w4d-plan — docs/PROTOCOL.md §42.1: an approved plan handed to another workbench of the repository
 * (`plan_response {approve, into: "workbench", path}`). The source engine writes it into the target's git dir; the target's
 * engine takes it (once) when it opens the project and implements it in a fresh chat — a normal send through the gate.
 */

export const PLAN_HANDOFF_FILE = "plan-handoff.json";
/** A handoff older than this is dropped unread (the window that should have taken it never opened). */
export const PLAN_HANDOFF_MAX_AGE_MS = 15 * 60 * 1000;

export type PlanHandoff = {
  version: 1;
  /** The worktree the plan was approved in. */
  from: { path: string; name: string };
  /** The plan file, null when the plan only came through ExitPlanMode (its text is in the follow-up). */
  planPath: string | null;
  plan: string;
  /** The mode the implementation runs in (one of the four; never a bypass). */
  mode: PermissionMode;
  /** The follow-up instruction sent in the target's fresh chat. */
  text: string;
  /** ISO-8601 */
  at: string;
};

const handoffPath = (gitDir: string) => join(gitDir, "reviewgate", PLAN_HANDOFF_FILE);

export async function writePlanHandoff(gitDir: string, handoff: PlanHandoff): Promise<void> {
  mkdirSync(join(gitDir, "reviewgate"), { recursive: true });
  await writeAtomicJSON(handoffPath(gitDir), handoff);
}

/** Reads and removes the handoff waiting in `gitDir` (null: none, unreadable, malformed or stale). */
export function takePlanHandoff(gitDir: string, now: number = Date.now()): PlanHandoff | null {
  const path = handoffPath(gitDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  rmSync(path, { force: true });
  let v: Partial<PlanHandoff>;
  try {
    v = JSON.parse(raw) as Partial<PlanHandoff>;
  } catch {
    return null;
  }
  if (!v || v.version !== 1 || typeof v.plan !== "string" || typeof v.text !== "string" || !v.text.trim() || typeof v.at !== "string") return null;
  if (!isPermissionMode(v.mode) || v.mode === "plan") return null;
  const at = Date.parse(v.at);
  if (!Number.isFinite(at) || now - at > PLAN_HANDOFF_MAX_AGE_MS || at - now > PLAN_HANDOFF_MAX_AGE_MS) return null;
  const fromPath = typeof v.from?.path === "string" ? v.from.path : "";
  return {
    version: 1,
    from: { path: fromPath, name: typeof v.from?.name === "string" && v.from.name ? v.from.name : basename(fromPath) },
    planPath: typeof v.planPath === "string" && v.planPath ? v.planPath : null,
    plan: v.plan.slice(0, MAX_PLAN_BYTES),
    mode: v.mode,
    text: v.text,
    at: v.at,
  };
}

/**
 * The instruction that starts an approved plan in a chat that has not seen it (a fresh chat, another workbench): the plan
 * file's path — Claude reads it — or, for a plan that only came through ExitPlanMode, the plan itself.
 */
export function implementPlanText(path: string | null, plan: string): string {
  if (path !== null) return `Implement the approved plan at ${path} (it was made in an earlier chat — read it first).`;
  return `Implement this approved plan (it was made in an earlier chat).\n\n<plan>\n${plan}\n</plan>`;
}
