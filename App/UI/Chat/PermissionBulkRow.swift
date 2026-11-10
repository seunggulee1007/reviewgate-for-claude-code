import SwiftUI
import ReviewGateCore

// MARK: r2-peers — M26 (docs/PROTOCOL.md §33.1 on the Mac): parallel subagents each hold a card, and one card at a time was
// all the keys and buttons answered. Under a card that may go together with others: "대기 중 N개 모두 허용" (on the first
// of them) and, on a subagent's card, "이 에이전트의 요청은 이번 턴 동안 허용". Each is the ordinary permission_response
// per request — no engine change. Never a question, a plan, a SendMessage or a red card (PermissionCardOptions.bundles).

struct PermissionBulkRow: View {
    @Environment(AppState.self) private var store
    let request: PermissionRequest

    var body: some View {
        let bundle = store.permissionBundle
        let showsAll = bundle.first?.requestId == request.requestId
        let agentId = PermissionCardOptions.bundles(request) ? request.agent?.agentId : nil
        if showsAll || agentId != nil {
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                if let agentId {
                    Button("Allow this agent's requests for this turn") { store.allowAgentForTurn(agentId) }
                        .controlSize(.small)
                        .help("Allows this subagent's waiting requests and the ones it makes until the turn ends — red cards still ask")
                        .accessibilityIdentifier("Allow agent for turn")
                }
                if showsAll {
                    Button("Allow all \(bundle.count) waiting") { store.allowWaitingPermissions() }
                        .controlSize(.small)
                        .help("Allows every waiting request that can go together — not a question, a message to another session or a red card")
                        .accessibilityIdentifier("Allow all waiting")
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Permission bulk answers")
        }
    }
}
