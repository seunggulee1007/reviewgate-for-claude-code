/**
 * OS notifications and the attention badge — the pure part (no `electron`), unit-tested. The renderer asks
 * through `rg:notify` (src/main/notifications.ts); main validates the request, shows it only while the
 * window is not focused and the setting is on, coalesces repeats, and counts what the user has not seen
 * yet per window (dock / taskbar badge, Windows overlay icon + frame flash), cleared when the window gains focus.
 */
import type { NotifyKind, NotifyRequest, NotifyTarget } from "../shared/ipc.js";
import { t } from "../renderer/i18n"; // MARK: wave4d w4d-windows

export const NOTIFY_KINDS: ReadonlySet<NotifyKind> = new Set<NotifyKind>(["turn_done", "permission", "plan", "question", "error", "side_answer", "peer_message", "agents_done"]);
const MAX_TITLE = 120;
const MAX_BODY = 400;
const MAX_KEY = 200;

const cleanText = (v: unknown, max: number): string | null => {
  if (typeof v !== "string" || v.includes("\0")) return null;
  // Control characters (other than spaces) never reach the OS notification centre.
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return s.length === 0 ? null : s.length > max ? s.slice(0, max - 1) + "…" : s;
};

/** A plain `{kind, title, body, key}` with an allowlisted kind and bounded strings; anything else → null. */
export function validateNotify(raw: unknown): NotifyRequest | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["kind"] !== "string" || !NOTIFY_KINDS.has(r["kind"] as NotifyKind)) return null;
  const title = cleanText(r["title"], MAX_TITLE);
  const body = r["body"] === "" ? "" : cleanText(r["body"], MAX_BODY);
  const key = cleanText(r["key"], MAX_KEY);
  if (title === null || body === null || key === null) return null;
  const target = validTarget(r["target"]); // MARK: wave4b w4-notify
  return { kind: r["kind"] as NotifyKind, title, body, key, ...(target ? { target } : {}) };
}

// MARK: wave4b w4-notify — §39.6 notifications you notice

const MAX_ID = 200;
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_ID && !/[\u0000-\u001f\u007f]/.test(v);

/** A click's target: a plain object of short ids; anything else is dropped (the notification itself stays). */
function validTarget(raw: unknown): NotifyTarget | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return null;
  const r = raw as Record<string, unknown>;
  if ((r["chatId"] !== undefined && !isId(r["chatId"])) || (r["requestId"] !== undefined && !isId(r["requestId"]))) return null;
  const out: NotifyTarget = {};
  if (isId(r["chatId"])) out.chatId = r["chatId"];
  if (isId(r["requestId"])) out.requestId = r["requestId"];
  return Object.keys(out).length > 0 ? out : null;
}

/** Settings › Notifications' three switches (the Mac's `NotificationGroup`): what waits for an answer, finished work, the rest. */
export type NotifyGroup = "waiting" | "turnEnd" | "other";

export function notifyGroupOf(kind: NotifyKind): NotifyGroup {
  if (kind === "permission" || kind === "question" || kind === "plan") return "waiting";
  if (kind === "turn_done") return "turnEnd";
  return "other";
}

const GROUP_KEY = { waiting: "notifyWaiting", turnEnd: "notifyTurnEnd", other: "notifyOther" } as const;

/** A group's switch; absent = on. */
export function groupEnabled(settings: Partial<Record<(typeof GROUP_KEY)[NotifyGroup], boolean>>, group: NotifyGroup): boolean {
  return settings[GROUP_KEY[group]] !== false;
}

/**
 * Windows shows a toast only for an AppUserModelId with a Start menu shortcut: the NSIS installer gives its shortcut the
 * package's `appId` (electron-builder.yml), so the installed app must name the same id. Run from a checkout there is no
 * shortcut — Electron's advice is the executable's path.
 */
export const APP_USER_MODEL_ID = "io.github.seunggulee1007.reviewgate.desktop";

export function appUserModelId(isPackaged: boolean, execPath: string): string {
  return isPackaged ? APP_USER_MODEL_ID : execPath;
}

/** The OS notification settings, by a fixed address (never one the renderer sends). */
export function notificationSettingsUrl(platform: NodeJS.Platform): string | null {
  if (platform === "win32") return "ms-settings:notifications";
  if (platform === "darwin") return "x-apple.systempreferences:com.apple.preference.notifications";
  return null;
}

/** Shown at all? Only for a window the user is not looking at, and only with the setting on. */
export function shouldNotify(o: { enabled: boolean; focused: boolean; supported: boolean }): boolean {
  return o.enabled && o.supported && !o.focused;
}

/**
 * Drops a request whose `key` was shown for the same window within `windowMs` (a permission request that
 * the engine re-emits, a burst of identical errors). A different key always passes.
 */
export class Coalescer {
  private last = new Map<string, number>();
  constructor(
    private readonly windowMs = 5000,
    private readonly now: () => number = Date.now,
  ) {}
  admit(winId: number, key: string): boolean {
    const k = `${winId}\u0000${key}`;
    const t = this.now();
    const prev = this.last.get(k);
    if (prev !== undefined && t - prev < this.windowMs) return false;
    this.last.set(k, t);
    if (this.last.size > 500) for (const [kk, v] of this.last) if (t - v >= this.windowMs) this.last.delete(kk);
    return true;
  }
  forget(winId: number): void {
    for (const k of [...this.last.keys()]) if (k.startsWith(`${winId}\u0000`)) this.last.delete(k);
  }
}

/** Unseen notifications per window; the badge is their sum. */
export class AttentionCounter {
  private counts = new Map<number, number>();
  add(winId: number): void {
    this.counts.set(winId, (this.counts.get(winId) ?? 0) + 1);
  }
  clear(winId: number): void {
    this.counts.delete(winId);
  }
  count(winId: number): number {
    return this.counts.get(winId) ?? 0;
  }
  total(): number {
    let n = 0;
    for (const v of this.counts.values()) n += v;
    return n;
  }
}

/** The badge text of the Windows overlay icon description / accessibility label. */
export function badgeDescription(count: number): string {
  // MARK: wave4d w4d-windows (polish-07): in the UI language (`initI18n` in main.ts)
  return count <= 0 ? "" : count === 1 ? t("1 item needs attention") : t("{0} items need attention", count > 99 ? "99+" : count);
}

/** RGBA pixels of a filled red dot (`size`×`size`) — the Windows taskbar overlay icon, built without an asset file. */
export function dotBitmap(size = 16): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const r = size / 2 - 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const a = d <= r - 0.5 ? 255 : d <= r + 0.5 ? Math.round((r + 0.5 - d) * 255) : 0;
      const i = (y * size + x) * 4;
      // BGRA (Electron's `createFromBitmap` on Windows) — red is the third byte.
      buf[i] = 0x38;
      buf[i + 1] = 0x34;
      buf[i + 2] = 0xd1;
      buf[i + 3] = a;
    }
  }
  return buf;
}
