import Foundation
import Testing
@testable import ReviewGateCore

/// polish P1-chrome-07 (docs/PROTOCOL.md §55.8): File › Open Recent names a project by its folder, with its parent when two
/// share a name; Clear Menu forgets the list.
@Suite struct RecentMenuTests {
    @Test func aFolderByItsNameAndItsParentWhenTwoShareIt() {
        let urls = ["/work/acme/api", "/work/beta/api", "/work/acme-web", "/Users/dev/a/x/app", "/Users/dev/b/x/app"]
            .map { URL(fileURLWithPath: $0) }
        #expect(RecentMenu.titles(urls, home: "/Users/dev") == [
            "api — acme", "api — beta", "acme-web", "app — ~/a/x", "app — ~/b/x",
        ])
        #expect(RecentMenu.titles([], home: "/Users/dev").isEmpty)
    }

    @Test func clearMenuForgetsTheRecentsButNotTheWindowsToReopen() {
        let defaults = UserDefaults(suiteName: "RecentMenuTests.\(UUID().uuidString)")!
        AppSettings.addRecentProject(URL(fileURLWithPath: "/work/acme-api"), defaults: defaults)
        AppSettings.setOpenWindows([AppSettings.OpenWindowState(path: "/work/acme-api", frame: nil)], defaults: defaults)
        AppSettings.clearRecentProjects(defaults: defaults)
        #expect(AppSettings.recentProjects(defaults: defaults).isEmpty)
        #expect(AppSettings.openWindows(defaults: defaults).map(\.path) == ["/work/acme-api"])
    }
}
