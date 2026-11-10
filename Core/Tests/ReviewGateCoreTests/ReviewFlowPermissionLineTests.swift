import Foundation
import Testing
@testable import ReviewGateCore

/// r2-review-flow M27: the one-line permission rows of the transcript.
@Suite struct PermissionLineTextTests {
    private func request(_ tool: String, _ input: JSONValue, file: String? = nil) -> PermissionRequest {
        PermissionRequest(requestId: "r1", toolName: tool, input: input, file: file)
    }

    @Test func aDecidedCardIsOneLineWithItsAnswerAndCall() {
        let bash = request("Bash", .object(["command": .string("git commit -m \"fix cart total\"\ngit push")]))
        #expect(PermissionLineText.text(request: bash, decision: true, isOpen: false) == "Allowed · Bash git commit -m \"fix cart total\" …")
        #expect(PermissionLineText.text(request: bash, decision: false, isOpen: false) == "Denied · Bash git commit -m \"fix cart total\" …")
        #expect(PermissionLineText.text(request: bash, decision: nil, isOpen: false) == "Handled · Bash git commit -m \"fix cart total\" …")
        #expect(PermissionLineText.text(request: bash, decision: nil, isOpen: true) == "Waiting for your answer below · Bash git commit -m \"fix cart total\" …")
        let edit = request("Write", .object(["file_path": .string("/work/acme/.env")]), file: "/work/acme/.env")
        #expect(PermissionLineText.text(request: edit, decision: true, isOpen: false) == "Allowed · Write /work/acme/.env")
        let send = request("SendMessage", .object(["to": .string("uds:/tmp/cc-socks/1.sock"), "message": .string("hi")]))
        #expect(PermissionLineText.status(request: send, decision: true, isOpen: false) == .sent)
        #expect(PermissionLineText.status(request: send, decision: false, isOpen: false) == .notSent)
        #expect(PermissionLineText.help(status: .waiting) != PermissionLineText.help(status: .allowed))
    }
}
