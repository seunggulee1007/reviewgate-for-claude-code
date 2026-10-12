/**
 * MARK: wave4d w4d-agents2 — docs/PROTOCOL.md §42.4: small pieces of the agent panel — the token gauge (was "▤", the Mac's
 * "#").
 */

/** A small gauge (the token count of an agent card), in the text color. */
export function GaugeIcon() {
  return (
    <svg className="gauge-icon" width="11" height="11" viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={{ verticalAlign: "-1px" }}>
      <path d="M2.5 11.5a5.5 5.5 0 1 1 11 0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M8 11.5 10.9 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="8" cy="11.5" r="1.3" fill="currentColor" />
    </svg>
  );
}
