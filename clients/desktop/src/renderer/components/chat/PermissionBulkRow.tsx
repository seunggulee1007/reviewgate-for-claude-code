/**
 * MARK: r2-peers — docs/PROTOCOL.md §33.1 in the Windows client, as the Mac's PermissionBulkRow: parallel subagents each
 * hold a card, and one card at a time was all the keys and buttons answered. Under a card that may go together with
 * others: "대기 중 N개 모두 허용" (on the first of them) and, on a subagent's card, "이 에이전트의 요청은 이번 턴 동안 허용".
 * Each is the ordinary permission_response per request — no engine change. Never a question, a plan, a SendMessage or a
 * red card (`bundles`).
 */
import type { PermissionRequest } from "@reviewgate/engine";
import { t } from "../../i18n";
import { bundles, pendingPermissionsOf, permissionBundle } from "../../permissionQueue";
import { useStore } from "../../store";

export function PermissionBulkRow({ request }: { request: PermissionRequest }) {
  // Primitives only: a selector that returns a new array on every call never settles (zustand 5 compares by identity).
  const firstId = useStore((s) => permissionBundle(pendingPermissionsOf(s.state))[0]?.requestId ?? null);
  const count = useStore((s) => permissionBundle(pendingPermissionsOf(s.state)).length);
  const allowAll = useStore((s) => s.allowWaitingPermissions);
  const allowAgent = useStore((s) => s.allowAgentForTurn);
  const showsAll = firstId === request.requestId;
  const agentId = bundles(request) ? (request.agent?.agentId ?? null) : null;
  if (!showsAll && agentId === null) return null;
  return (
    <div className="actions bulk" data-testid="Permission bulk answers">
      <span className="spacer" />
      {agentId !== null && (
        <button type="button" className="small" onClick={() => allowAgent(agentId)} title={t("Allows this subagent's waiting requests and the ones it makes until the turn ends — red cards still ask")} data-testid="Allow agent for turn">
          {t("Allow this agent's requests for this turn")}
        </button>
      )}
      {showsAll && (
        <button type="button" className="small" onClick={allowAll} title={t("Allows every waiting request that can go together — not a question, a message to another session or a red card")} data-testid="Allow all waiting">
          {t("Allow all {0} waiting", count)}
        </button>
      )}
    </div>
  );
}
