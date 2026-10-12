import Foundation
import Testing
@testable import ReviewGateCore

// MARK: wave4b w4b-files — docs/PROTOCOL.md §40.2 (comp-14): the same cases as Electron's fileGroups.test.ts.

@Suite struct FileGroupsTests {
    private let acme = [
        "src/main/webapp/WEB-INF/jsp/user/orders/billing/refund/refundForm.jsp",
        "src/test/java/com/acme/orders/billing/InvoiceServiceTest.java",
        "src/main/resources/mapper/orders/billing/RefundMapper.xml",
        "src/main/java/com/acme/orders/billing/InvoiceServiceImpl.java",
        "src/main/java/com/acme/orders/billing/RefundController.java",
        "src/main/resources/application-dev.yml",
        "README.md",
    ]

    private func file(_ path: String, external: Bool = false) -> ChangedFile {
        var f = ChangedFile(path: path, oldPath: nil, status: .modified, added: 1, deleted: 1, isBinary: false, tools: external ? [] : ["Edit"], toolUseIds: external ? [] : ["t1"])
        f.origin = external ? .external : .tool
        return f
    }

    @Test func readsASpringProjectsLayers() {
        #expect(acme.map { FileGroups.layer(of: $0) } == [.webapp, .test, .mapper, .service, .controller, .resources, .other])
        #expect(FileGroups.layer(of: "src/main/java/com/acme/orders/billing/dao/RefundDao.java") == .mapper)
        #expect(FileGroups.layer(of: "src/main/java/com/acme/orders/billing/service/impl/Refund.java") == .service)
        #expect(FileGroups.layer(of: "src/main/java/com/acme/orders/web/controller/Home.java") == .controller)
        #expect(FileGroups.layer(of: "src/test/java/com/acme/RefundControllerTest.java") == .test)
        #expect(FileGroups.layer(of: "engine/src/engine.ts") == .other)
    }

    @Test func groupsByLayerAndFolderKeepingTheIncomingOrder() {
        let sections = FileGroups.group(acme, by: .layer, path: { $0 })
        #expect(sections.map(\.key) == ["controller", "service", "mapper", "resources", "webapp", "test", "other"])
        let byFolder = FileGroups.group(["b/x.ts", "a/y.ts", "b/z.ts", "root.ts"], by: .folder, path: { $0 })
        #expect(byFolder.map(\.key) == ["b", "a", ""])
        #expect(byFolder.map(\.files) == [["b/x.ts", "b/z.ts"], ["a/y.ts"], ["root.ts"]])
        #expect(FileGroups.group(acme, by: .none, path: { $0 }).map(\.files) == [acme])
    }

    @Test func compactsSourceRootsKeepingTheModule() {
        #expect(FileGroups.compactPath("src/main/java/com/acme/orders/billing/InvoiceServiceImpl.java") == "…/orders/billing/InvoiceServiceImpl.java")
        #expect(FileGroups.compactPath("acme-api/src/main/java/com/acme/orders/Api.java") == "acme-api/…/orders/Api.java")
        #expect(FileGroups.compactPath("src/main/resources/mapper/orders/billing/RefundMapper.xml") == "…/mapper/orders/billing/RefundMapper.xml")
        #expect(FileGroups.compactPath("src/main/webapp/WEB-INF/jsp/user/orders/billing/refund/refundForm.jsp") == "…/user/orders/billing/refund/refundForm.jsp")
        #expect(FileGroups.compactPath("src/main/java/com/acme/App.java") == "…/com/acme/App.java")
        #expect(FileGroups.compactPath("engine/src/engine.ts") == "engine/src/engine.ts")
        #expect(FileGroups.compactPath("README.md") == "README.md")
        #expect(FileGroups.sectionLabel(.folder, key: "src/main/java/com/acme/orders/billing") == "…/orders/billing")
    }

    @Test func splitsEachGroupAndKeepsTheChoicePerProject() throws {
        let files = [file("src/main/java/com/acme/A.java"), file("x/BService.java"), file("y/CController.java", external: true)]
        let sections = AppState.subgrouped(ChangedFileSection.build(files, riskOrder: false), by: .layer, keep: nil)
        #expect(sections.map(\.id) == ["claude#service", "claude#other", "external#controller"])
        #expect(sections.flatMap(\.files).map(\.path) == ["x/BService.java", "src/main/java/com/acme/A.java", "y/CController.java"])
        // The author filter narrows before the split: a section with none of its files is not listed.
        let kept = AppState.subgrouped(ChangedFileSection.build(files, riskOrder: false), by: .layer, keep: { $0.path != "x/BService.java" })
        #expect(kept.map(\.id) == ["claude#other", "external#controller"])

        let defaults = try #require(UserDefaults(suiteName: "FileGroupsTests-\(UUID().uuidString)"))
        #expect(FileGroups.choice(for: "/repo/a", defaults: defaults) == .none)
        FileGroups.setChoice(.layer, for: "/repo/a", defaults: defaults)
        FileGroups.setChoice(.folder, for: "/repo/b", defaults: defaults)
        #expect(FileGroups.choice(for: "/repo/a", defaults: defaults) == .layer)
        #expect(FileGroups.choice(for: "/repo/b", defaults: defaults) == .folder)
        #expect(FileGroups.choice(for: nil, defaults: defaults) == .none)
    }
}
