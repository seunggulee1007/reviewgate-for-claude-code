/**
 * Classifies Claude CLI / API failures into the stable `error.code`s clients localize (docs/PROTOCOL.md §19.6):
 * `auth_required`, `usage_limit`, `rate_limited`, `api_error`. Sources: the SDK's `SDKAssistantMessageError`
 * (on a synthetic assistant message and on `system/api_retry`), a `result` with `is_error`, `rate_limit_event`,
 * `auth_status`, and — as a last resort — the text of an error / the CLI's stderr.
 */

export type ApiErrorCode = "auth_required" | "usage_limit" | "rate_limited" | "api_error";

/** `SDKAssistantMessageError` values (sdk.d.ts) → code; null for values that are no user-facing failure. */
export function codeOfAssistantError(error: string | undefined | null): ApiErrorCode | null {
  switch (error) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
    case "account_on_hold":
    case "verification_required":
    case "cloud_credential_error":
      return "auth_required";
    case "billing_error":
      return "usage_limit";
    case "rate_limit":
      return "rate_limited";
    case "overloaded":
    case "server_error":
    case "invalid_request":
    case "model_not_found":
    case "unknown":
      return "api_error";
    default:
      return null; // max_output_tokens, absent, or a value newer than this table
  }
}

const AUTH_RE = /invalid api key|please run \/login|run \/login|not logged in|log ?in required|authentication[_ ](error|failed)|oauth token (has )?(expired|been revoked)|invalid x-api-key|\b401\b/i;
const USAGE_RE = /usage limit|limit reached|hit your (usage )?limit|out of (extra )?(usage|credits)|credit balance is too low|weekly limit|5-hour limit|session limit/i;
const RATE_RE = /rate[ _-]?limit|too many requests|\b429\b/i;
const API_RE = /api error|overloaded|internal server error|service unavailable|bad gateway|gateway timeout|\b5\d\d\b|connection (error|refused|reset)|ECONNRESET|ETIMEDOUT|fetch failed/i;

/** Classifies free error text (an `errors[]` entry, a `result` text, an exception, stderr); null when nothing matches. */
export function codeOfErrorText(text: string | undefined | null): ApiErrorCode | null {
  if (!text) return null;
  if (AUTH_RE.test(text)) return "auth_required";
  if (USAGE_RE.test(text)) return "usage_limit";
  if (RATE_RE.test(text)) return "rate_limited";
  if (API_RE.test(text)) return "api_error";
  return null;
}

/** An API-error turn's `result.api_error_status` → code (null for no / an unknown status). */
export function codeOfStatus(status: number | null | undefined): ApiErrorCode | null {
  if (typeof status !== "number") return null;
  if (status === 401 || status === 403) return "auth_required";
  if (status === 429) return "rate_limited";
  if (status >= 500 || status === 400 || status === 404 || status === 413) return "api_error";
  return null;
}

/** English fallback messages (clients show their own, localized by `code`). */
export const API_ERROR_MESSAGES: Record<ApiErrorCode | "api_retrying" | "cli_start_slow", string> = {
  auth_required: "Claude Code is not logged in (or the login expired). Run `claude` in a terminal and log in (/login), then restart the session.",
  usage_limit: "Your Claude usage limit is reached.",
  rate_limited: "The Claude API rate limit was hit; wait a moment and try again.",
  api_error: "The Claude API returned an error.",
  api_retrying: "The Claude API request failed; Claude Code is retrying.",
  cli_start_slow: "Claude Code is taking unusually long to start. A VPN / proxy, a slow plugin marketplace update or an MCP server can delay it.",
};

/** Unix seconds or milliseconds → ISO-8601; undefined when absent / not a number. */
export function isoFromEpoch(t: number | undefined | null): string | undefined {
  if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) return undefined;
  const ms = t < 1e12 ? t * 1000 : t;
  return new Date(ms).toISOString();
}

/** The first line of `text`, capped, for an error message's detail. */
export function firstLineOf(text: string, max = 300): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}
