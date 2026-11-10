/**
 * MARK: polish p-foundation — PX-21: "3분 전" that keeps up while the window stays open (worked out again every 30 s —
 * `relativeTime()` alone is computed once and then stands still), with the exact time on hover ("2026. 11. 6. 오후 3:42").
 *
 *   <RelTime iso={pr.updatedAt} className="caption muted" />
 *   const now = useNow();   // any other text that counts from now
 */
import { useSyncExternalStore } from "react";
import { formatDate, relativeTime } from "../../i18n";
import "./common.css";

/** `iso` relative to now ("3분 전", "어제"), refreshed every 30 s, with the date and time as its tooltip; nothing without a time. */
export function RelTime({ iso, className }: { iso: string | null | undefined; className?: string }) {
  useNow();
  if (!iso) return null;
  return (
    <time dateTime={iso} title={formatDate(iso)} className={className}>
      {relativeTime(iso)}
    </time>
  );
}

type Ticker = { now: number; listeners: Set<() => void>; timer: ReturnType<typeof setInterval> | null; subscribe: (cb: () => void) => () => void; snapshot: () => number };

const tickers = new Map<number, Ticker>();

/** One shared timer per interval for every component that counts from now (a list of 200 rows runs one timer). */
export function nowTicker(intervalMs: number): Pick<Ticker, "subscribe" | "snapshot"> {
  let ticker = tickers.get(intervalMs);
  if (!ticker) {
    const t: Ticker = {
      now: Date.now(),
      listeners: new Set(),
      timer: null,
      subscribe(cb) {
        t.listeners.add(cb);
        if (t.timer === null) {
          t.now = Date.now();
          t.timer = setInterval(() => {
            t.now = Date.now();
            for (const l of [...t.listeners]) l();
          }, intervalMs);
        }
        return () => {
          t.listeners.delete(cb);
          if (t.listeners.size === 0 && t.timer !== null) {
            clearInterval(t.timer);
            t.timer = null;
          }
        };
      },
      snapshot: () => t.now,
    };
    tickers.set(intervalMs, t);
    ticker = t;
  }
  return ticker;
}

/** The time now, updated every `intervalMs` (default 30 s): the component renders again on each tick. */
export function useNow(intervalMs = 30_000): number {
  const ticker = nowTicker(intervalMs);
  return useSyncExternalStore(ticker.subscribe, ticker.snapshot, ticker.snapshot);
}
