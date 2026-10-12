import Foundation
import Testing
@testable import ReviewGateCore

@Suite struct ProjectSettingsTests {
    @Test func recentProjectsDedupeOrderAndCap() {
        let d = UserDefaults(suiteName: "ProjectSettingsTests.\(UUID().uuidString)")!
        #expect(AppSettings.recentProjects(defaults: d).isEmpty)

        AppSettings.addRecentProject(URL(fileURLWithPath: "/Users/me/a"), defaults: d)
        AppSettings.addRecentProject(URL(fileURLWithPath: "/Users/me/b"), defaults: d)
        AppSettings.addRecentProject(URL(fileURLWithPath: "/Users/me/a/"), defaults: d)   // same folder, trailing slash
        #expect(AppSettings.recentProjects(defaults: d).map(\.path) == ["/Users/me/a", "/Users/me/b"])

        for i in 0..<20 { AppSettings.addRecentProject(URL(fileURLWithPath: "/Users/me/p\(i)"), defaults: d) }
        let list = AppSettings.recentProjects(defaults: d)
        #expect(list.count == AppSettings.maxRecentProjects)
        #expect(list.first?.path == "/Users/me/p19")
        #expect(!list.contains { $0.path == "/Users/me/a" })

        AppSettings.removeRecentProject(URL(fileURLWithPath: "/Users/me/p19"), defaults: d)
        #expect(AppSettings.recentProjects(defaults: d).first?.path == "/Users/me/p18")
        #expect(AppSettings.recentProjects(defaults: d).count == AppSettings.maxRecentProjects - 1)
    }

    /// M18: the appearance setting round-trips, defaults to `.system`, and ignores a stale/garbage value.
    @Test func appearanceRoundTrip() {
        let d = UserDefaults(suiteName: "ProjectSettingsTests.\(UUID().uuidString)")!
        #expect(AppSettings.appearance(defaults: d) == .system)

        for appearance in Appearance.allCases {
            AppSettings.setAppearance(appearance, defaults: d)
            #expect(d.string(forKey: AppSettings.Key.appearance) == appearance.rawValue)
            #expect(AppSettings.appearance(defaults: d) == appearance)
        }

        d.set("sepia", forKey: AppSettings.Key.appearance)
        #expect(AppSettings.appearance(defaults: d) == .system)

        #expect(Appearance.allCases.map(\.rawValue) == ["system", "light", "dark"])
        #expect(Appearance.allCases.allSatisfy { !$0.displayName.isEmpty })
    }

    /// M19: the window list survives a quit — order, frames and the "reopen" toggle.
    @Test func openWindowsRoundTrip() {
        let d = UserDefaults(suiteName: "ProjectSettingsTests.\(UUID().uuidString)")!
        #expect(AppSettings.openWindows(defaults: d).isEmpty)
        #expect(AppSettings.reopenLastProjects(defaults: d))          // unset → on

        let frame = "{{120, 240}, {1400, 900}}"
        AppSettings.setOpenWindows([
            AppSettings.OpenWindowState(path: "/tmp/rg-p1", frame: frame),
            AppSettings.OpenWindowState(path: "/tmp/rg-p2"),
        ], defaults: d)
        let restored = AppSettings.openWindows(defaults: d)
        #expect(restored.map(\.path) == ["/tmp/rg-p1", "/tmp/rg-p2"])  // saved order
        #expect(restored.first?.frame == frame)
        #expect(restored.last?.frame == nil)

        AppSettings.setOpenWindows([], defaults: d)
        #expect(AppSettings.openWindows(defaults: d).isEmpty)

        d.set(false, forKey: AppSettings.Key.reopenLastProjects)
        #expect(!AppSettings.reopenLastProjects(defaults: d))
        d.set(true, forKey: AppSettings.Key.reopenLastProjects)
        #expect(AppSettings.reopenLastProjects(defaults: d))

        #expect(AppSettings.maxRestoredWindows == 5)
    }

    /// M19: the per-project frame rides along in `ProjectUIState` without disturbing the M15/M16 fields.
    @Test func projectUIStateKeepsWindowFrame() {
        let d = UserDefaults(suiteName: "ProjectSettingsTests.\(UUID().uuidString)")!
        #expect(AppSettings.projectUIState(root: "/tmp/rg-p1", defaults: d).frame == nil)

        var state = AppSettings.projectUIState(root: "/tmp/rg-p1", defaults: d)
        state.diffFraction = 0.42
        state.frame = "{{0, 0}, {1200, 800}}"
        AppSettings.setProjectUIState(state, root: "/tmp/rg-p1", defaults: d)

        let read = AppSettings.projectUIState(root: "/tmp/rg-p1", defaults: d)
        #expect(read.frame == "{{0, 0}, {1200, 800}}")
        #expect(read.diffFraction == 0.42)
        #expect(AppSettings.projectUIState(root: "/tmp/rg-p2", defaults: d).frame == nil)
    }

    /// M19: the key the window registry, the recents list and `openWindows` all compare projects by —
    /// the "already open → focus that window" lookup hinges on it.
    @Test func projectKeyStandardizesPaths() {
        #expect(AppSettings.projectKey(URL(fileURLWithPath: "/tmp/rg-p1/")) == "/tmp/rg-p1")
        #expect(AppSettings.projectKey(URL(fileURLWithPath: "/tmp/./rg-p1")) == "/tmp/rg-p1")
        #expect(AppSettings.projectKey(URL(fileURLWithPath: "/tmp/rg-p2/../rg-p1")) == "/tmp/rg-p1")
        #expect(AppSettings.projectKey(URL(fileURLWithPath: "/tmp/rg-p1")) != AppSettings.projectKey(URL(fileURLWithPath: "/tmp/rg-p2")))
    }
}
