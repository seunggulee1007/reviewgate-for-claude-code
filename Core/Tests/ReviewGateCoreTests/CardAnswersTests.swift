import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import ReviewGateCore

/// r2-chats-cards: how a permission card is denied (M25, docs/PROTOCOL.md §33.10), a question card's notes (M08b,
/// `updatedInput.annotations`) and a big screenshot scaled down instead of refused (M34, §24).
@Suite @MainActor struct CardAnswersTests {
    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "CardAnswersTests.\(UUID().uuidString)")!)
    }

    private func wire(_ command: EngineCommand) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: NDJSON.encodeLine(EngineCommandEnvelope(command: command))) as? [String: Any])
    }

    // MARK: M25

    @Test func theFourDenialsOnTheWire() throws {
        let plain = try wire(.permissionDeny(requestId: "R1", denial: .stop))
        #expect(plain["type"] as? String == "permission_response" && plain["requestId"] as? String == "R1" && plain["allow"] as? Bool == false)
        #expect(plain["message"] == nil && plain["skip"] == nil && plain["interrupt"] == nil)   // the engine says the CLI's "No"
        #expect(try wire(.permissionDeny(requestId: "R1", denial: .skip))["skip"] as? Bool == true)
        #expect(try wire(.permissionDeny(requestId: "R1", denial: .interrupt))["interrupt"] as? Bool == true)
        let instructed = try wire(.permissionDeny(requestId: "R1", denial: .instruction("run only the api tests")))
        #expect(instructed["message"] as? String == "run only the api tests" && instructed["skip"] == nil)
    }

    @Test func denyAnswersItsOwnCardAndAnEmptyInstructionIsAPlainNo() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.permissionRequest(PermissionRequest(requestId: "R1", toolName: "Bash", input: .object(["command": .string("npm test")]))))
        app.handle(.permissionRequest(PermissionRequest(requestId: "R2", toolName: "Bash", input: .object(["command": .string("make")]))))
        #expect(app.cardAnsweredByDraft?.requestId == "R1")
        app.denyPermission(requestId: "R2", .instruction("   "))
        #expect(sent.last == .permissionDeny(requestId: "R2", denial: .stop))
        app.denyPermission(requestId: "R1", .interrupt)
        #expect(sent.last == .permissionDeny(requestId: "R1", denial: .interrupt))
        #expect(app.openPermissions.isEmpty)
        // A card already answered sends nothing and says so.
        let count = sent.count
        app.denyPermission(requestId: "R1")
        #expect(sent.count == count && app.permissionNotice != nil)
    }

    // MARK: M08b

    private static let ask: JSONValue = .object(["questions": .array([
        .object(["question": .string("Which layout?"), "header": .string("Layout"), "multiSelect": .bool(false), "options": .array([
            .object(["label": .string("Grid"), "description": .string("cards"), "preview": .string("[ ][ ]")]),
            .object(["label": .string("List"), "description": .string("rows"), "preview": .string("----")]),
        ])]),
        .object(["question": .string("Which tests?"), "header": .string("Tests"), "multiSelect": .bool(true), "options": .array([
            .object(["label": .string("unit"), "description": .string("")]),
            .object(["label": .string("e2e"), "description": .string("")]),
        ])]),
    ])])

    @Test func notesGoOutAsAnnotationsKeyedByTheQuestion() throws {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let request = PermissionRequest(requestId: "Q1", toolName: "AskUserQuestion", input: Self.ask)
        app.handle(.permissionRequest(request))
        var draft = QuestionDraft(selected: ["Which layout?": ["Grid"], "Which tests?": ["unit", "e2e"]],
                                  notes: ["Which layout?": "  keep the header sticky ", "Which tests?": "   "])
        let questions = try #require(AskUserQuestions(request: request))
        #expect(draft.annotations(questions) == ["Which layout?": AskUserQuestions.Annotation(notes: "keep the header sticky", preview: "[ ][ ]")])
        app.answerQuestions(requestId: "Q1", draft: draft)
        guard case let .permissionResponse(id, allow, _, updated, _)? = sent.last else { Issue.record("no answer"); return }
        #expect(id == "Q1" && allow)
        let input = try #require(updated)
        #expect(input["answers"] == .object(["Which layout?": .string("Grid"), "Which tests?": .string("unit, e2e")]))
        #expect(input["annotations"] == .object(["Which layout?": .object(["notes": .string("keep the header sticky"), "preview": .string("[ ][ ]")])]))

        // No notes and no preview chosen: no `annotations` at all (as before).
        draft = QuestionDraft(selected: ["Which layout?": [], "Which tests?": ["unit"]], otherChosen: ["Which layout?"], otherText: ["Which layout?": "Masonry"])
        #expect(draft.annotations(questions).isEmpty)
        #expect(AskUserQuestions.updatedInput(for: request, answers: draft.answers(questions), annotations: [:])["annotations"] == nil)
    }

    // MARK: M34

    /// A `side`×`side` image of noise (incompressible: a PNG of it is about 4 bytes a pixel).
    private func noisePNG(side: Int, alpha: Bool) throws -> Data {
        let ctx = try #require(CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
                                         space: CGColorSpaceCreateDeviceRGB(),
                                         bitmapInfo: (alpha ? CGImageAlphaInfo.premultipliedLast : CGImageAlphaInfo.noneSkipLast).rawValue))
        let pixels = try #require(ctx.data).bindMemory(to: UInt32.self, capacity: side * side)
        var seed: UInt32 = 0x9E3779B9
        for i in 0..<(side * side) {
            seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5
            pixels[i] = alpha ? seed : (seed | 0xFF00_0000)
        }
        let image = try #require(ctx.makeImage())
        let out = NSMutableData()
        let dest = try #require(CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(dest, image, nil)
        #expect(CGImageDestinationFinalize(dest))
        return out as Data
    }

    private func longEdge(_ data: Data) -> Int {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else { return 0 }
        return max(props[kCGImagePropertyPixelWidth] as? Int ?? 0, props[kCGImagePropertyPixelHeight] as? Int ?? 0)
    }

    @Test func aBigScreenshotIsScaledDownNotRefused() throws {
        let big = try noisePNG(side: 2400, alpha: false)
        #expect(big.count > ComposerImage.maxBytes)
        guard case let .success(image) = ComposerImage.validated(big, name: "clipboard.png", existing: 0) else {
            Issue.record("refused"); return
        }
        #expect(image.data.count <= ComposerImage.maxBytes)
        #expect(image.resizedFrom == big.count)
        #expect(longEdge(image.data) <= ComposerImageFit.maxLongEdge)
        #expect(ImageMediaType(magic: image.data) == image.mediaType)
        #expect(image.name == "clipboard.\(image.mediaType.fileExtension)")

        // A small image is attached as it is; one that cannot be read is still refused.
        let small = try noisePNG(side: 64, alpha: true)
        guard case let .success(kept) = ComposerImage.validated(small, name: "a.png", existing: 0) else { Issue.record("refused"); return }
        #expect(kept.data == small && kept.resizedFrom == nil && kept.mediaType == .png)
        var broken = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        broken.append(Data(repeating: 0, count: ComposerImage.maxBytes + 10))
        #expect(ComposerImage.validated(broken, name: "x.png", existing: 0) == .failure(.tooLarge))
        #expect(ComposerImageFit.renamed("shot", to: .jpeg) == "shot.jpg")
    }
}
