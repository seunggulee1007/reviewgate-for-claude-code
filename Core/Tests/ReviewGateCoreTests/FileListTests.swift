import Foundation
import Testing
@testable import ReviewGateCore

// MARK: wave4b w4b-files — docs/PROTOCOL.md §40.2: the engine's risk badges (comp-12) and what a diff without lines is
// (comp-11), the same cases as Electron's riskEngine.test.ts / fileMeta.test.ts.

@Suite struct FileListTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private func file(_ path: String, risks: [String]? = nil, score: Int? = nil, status: ChangeStatus = .modified) -> ChangedFile {
        var f = ChangedFile(path: path, oldPath: nil, status: status, added: 1, deleted: 1, isBinary: false, tools: ["Edit"], toolUseIds: ["t1"])
        f.origin = .tool
        f.engineRisks = risks
        f.riskScore = score
        return f
    }

    @Test func readsTheEngineFieldsLeniently() throws {
        let f = try decode(ChangedFile.self, #"{"path":"run.sh","oldPath":null,"status":"M","added":0,"deleted":0,"isBinary":false,"tools":["Bash"],"toolUseIds":["b1"],"state":"pending","noteCount":0,"risks":["permission","bash"],"riskScore":70,"oldMode":"100644","newMode":"100755"}"#)
        #expect(f.engineRisks == ["permission", "bash"])
        #expect(f.riskScore == 70)
        #expect(f.oldMode == "100644" && f.newMode == "100755")
        // An older engine: nothing, and a wrong type never fails the snapshot.
        let old = try decode(ChangedFile.self, #"{"path":"a.ts","status":"M","risks":"oops","riskScore":"x"}"#)
        #expect(old.engineRisks == nil && old.riskScore == nil && old.similarity == nil)
        let summary = try decode(TurnSummary.File.self, #"{"path":"V1__init.sql","status":"A","state":"pending","adds":3,"dels":0,"tools":["Write"],"toolUseIds":["w1"],"risks":["schema"],"riskScore":35}"#)
        #expect(summary.risks == [.schema])
    }

    @Test func showsTheEngineKindsAndDropsUnknownOnes() {
        #expect(FileRisk.risks(for: file("src/main/resources/mapper/FooMapper.xml", risks: ["sql"], score: 25)) == [.sql])
        #expect(FileRisk.risks(for: file(".github/workflows/ci.yml", risks: ["sensitive", "ci", "future-kind"])) == [.sensitive, .ci])
        // "bash" is the Mac's viaBash; "external" has its own chip.
        #expect(FileRisk.risks(for: file("gen.txt", risks: ["bash", "external"])) == [.viaBash])
        // The engine's empty list wins over the old rules (which would call a lockfile config).
        #expect(FileRisk.risks(for: file("package-lock.json", risks: [])) == [])
        #expect(FileRisk.risks(for: file("package-lock.json")) == [.config])
    }

    @Test func ordersByTheEngineScoreWithTestsBelowTheirCode() {
        let service = file("src/main/java/FooService.java", risks: [], score: 0)
        let test = file("src/test/java/FooServiceTest.java", risks: ["test"], score: -1)
        let mapper = file("src/main/resources/mapper/FooMapper.xml", risks: ["sql"], score: 25)
        #expect(FileRisk.ordered([test, service, mapper]).map(\.path) == [mapper.path, service.path, test.path])
        // An older engine: the client's weights put a test below ordinary code too.
        #expect(FileRisk.score(file("src/test/java/FooTest.java")) < FileRisk.score(file("src/main/java/Foo.java")))
    }

    @Test func describesWhatADiffWithoutLinesIs() throws {
        func meta(_ json: String) throws -> [String] { FileMetaText.lines(try decode(FileDiff.self, json)) }
        #expect(try meta(#"{"oldPath":"src/Old.java","newPath":"src/New.java","isBinary":false,"hunks":[],"similarity":100}"#)
            == ["Moved without a content change (similarity 100%)"])
        #expect(try meta(#"{"oldPath":"a","newPath":"b","isBinary":false,"hunks":[],"similarity":87}"#) == ["Renamed (similarity 87%)"])
        #expect(try meta(#"{"oldPath":"run.sh","newPath":"run.sh","isBinary":false,"hunks":[],"oldMode":"100644","newMode":"100755"}"#)
            == ["Executable permission added 644→755"])
        #expect(try meta(#"{"oldPath":"x","newPath":"x","isBinary":false,"hunks":[],"oldMode":"100755","newMode":"100644"}"#)
            == ["Executable permission removed 755→644"])
        #expect(try meta(#"{"oldPath":null,"newPath":"x.sh","isBinary":false,"hunks":[],"newMode":"100755"}"#) == ["New executable file (755)"])
        #expect(try meta(#"{"oldPath":"l","newPath":"l","isBinary":false,"hunks":[],"oldMode":"100644","newMode":"120000"}"#)
            == ["File mode changed 100644→120000"])
        #expect(try meta(#"{"oldPath":"logo.png","newPath":"logo.png","isBinary":true,"hunks":[],"binarySize":{"old":12288,"new":14336}}"#)
            == ["Binary · 12KB → 14KB"])
        #expect(try meta(#"{"oldPath":null,"newPath":"a.png","isBinary":true,"hunks":[],"binarySize":{"old":null,"new":2048}}"#) == ["Binary · new file 2KB"])
        #expect(try meta(#"{"oldPath":"a.png","newPath":null,"isBinary":true,"hunks":[],"binarySize":{"old":500,"new":null}}"#) == ["Binary · deleted 500B"])
        #expect(try meta(#"{"oldPath":"a","newPath":"a","isBinary":true,"hunks":[]}"#) == [])
        #expect(try meta(#"{"oldPath":"a","newPath":"a","isBinary":false,"hunks":[]}"#) == [])
        #expect(FileMetaText.formatBytes(1023) == "1023B")
        #expect(FileMetaText.formatBytes(1536) == "2KB")
        #expect(FileMetaText.formatBytes(5 * 1024 * 1024 + 300 * 1024) == "5.3MB")
    }

    @Test func keepsTheMetaWhenADiffIsEncodedAgain() throws {
        let diff = try decode(FileDiff.self, #"{"oldPath":"a","newPath":"b","isBinary":false,"hunks":[],"similarity":100}"#)
        let again = try JSONDecoder().decode(FileDiff.self, from: JSONEncoder().encode(diff))
        #expect(again == diff)
        #expect(again.meta.similarity == 100)
    }
}
