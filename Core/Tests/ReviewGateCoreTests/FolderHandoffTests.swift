import Foundation
import Testing
@testable import ReviewGateCore

/// wave3 mac-session: handing a folder to the running app (docs/PROTOCOL.md §36.9 — client-only): a folder opened with the
/// app (`open -a ReviewGate <dir>`, Finder) or the link `reviewgate://open?path=<dir>`; a link to a folder the user never
/// opened here asks first; one hand-off reaching the app twice (AppKit and SwiftUI) opens once.
@Suite struct FolderHandoffTests {
    private let dirs: Set<String> = ["/Users/me/acme", "/Users/me/My Repo", "/Users/me/가게", NSHomeDirectory() + "/acme"]
    private func isDirectory(_ path: String) -> Bool { dirs.contains(path) }

    @Test func folderOpenedWithTheApp() {
        let request = FolderHandoff.request(for: URL(fileURLWithPath: "/Users/me/acme"), isDirectory: isDirectory)
        #expect(request == FolderHandoff.Request(folder: URL(fileURLWithPath: "/Users/me/acme"), source: .file))
        #expect(FolderHandoff.request(for: URL(fileURLWithPath: "/Users/me/acme/../acme/"), isDirectory: isDirectory)?.folder.path
                == "/Users/me/acme")
        // A file is not a project folder.
        #expect(FolderHandoff.request(for: URL(fileURLWithPath: "/Users/me/acme/README.md"), isDirectory: isDirectory) == nil)
    }

    @Test func openLinks() {
        func link(_ text: String) -> FolderHandoff.Request? {
            FolderHandoff.request(for: URL(string: text)!, isDirectory: isDirectory)
        }
        #expect(link("reviewgate://open?path=/Users/me/acme") == FolderHandoff.Request(folder: URL(fileURLWithPath: "/Users/me/acme"), source: .link))
        #expect(link("ReviewGate://open?path=%2FUsers%2Fme%2Facme")?.folder.path == "/Users/me/acme")
        #expect(link("reviewgate://open?path=/Users/me/My%20Repo")?.folder.path == "/Users/me/My Repo")
        #expect(link("reviewgate://open?path=/Users/me/%EA%B0%80%EA%B2%8C")?.folder.path == "/Users/me/가게")
        #expect(link("reviewgate://open?path=~/acme")?.folder.path == NSHomeDirectory() + "/acme")
        #expect(link("reviewgate:///open?path=/Users/me/acme")?.folder.path == "/Users/me/acme")
        // Not a folder hand-off.
        #expect(link("reviewgate://open?path=acme") == nil)            // relative
        #expect(link("reviewgate://open?path=/Users/me/nowhere") == nil)   // not a folder
        #expect(link("reviewgate://open") == nil)
        #expect(link("reviewgate://delete?path=/Users/me/acme") == nil)
        #expect(link("https://open?path=/Users/me/acme") == nil)
    }

    @Test func severalAtOnceOpenEachFolderOnce() {
        let urls = [URL(fileURLWithPath: "/Users/me/acme"), URL(string: "reviewgate://open?path=/Users/me/acme")!,
                    URL(fileURLWithPath: "/Users/me/My Repo"), URL(fileURLWithPath: "/Users/me/file.txt")]
        let requests = FolderHandoff.requests(for: urls, isDirectory: isDirectory)
        #expect(requests.map(\.folder.path) == ["/Users/me/acme", "/Users/me/My Repo"])
        #expect(requests.map(\.source) == [.file, .file])
    }

    @Test func aLinkToAnUnknownFolderAsksFirst() {
        let link = FolderHandoff.Request(folder: URL(fileURLWithPath: "/Users/me/acme"), source: .link)
        #expect(FolderHandoff.needsConfirmation(link, known: []))
        #expect(!FolderHandoff.needsConfirmation(link, known: [URL(fileURLWithPath: "/Users/me/acme/")]))
        let file = FolderHandoff.Request(folder: URL(fileURLWithPath: "/Users/me/acme"), source: .file)
        #expect(!FolderHandoff.needsConfirmation(file, known: []))
    }

    @Test func oneHandOffTwiceOpensOnce() {
        var gate = FolderHandoffGate()
        let now = Date()
        let folder = URL(fileURLWithPath: "/Users/me/acme")
        let first = gate.admit(folder, now: now)
        let again = gate.admit(URL(fileURLWithPath: "/Users/me/acme/"), now: now.addingTimeInterval(1))
        let other = gate.admit(URL(fileURLWithPath: "/Users/me/My Repo"), now: now.addingTimeInterval(1))
        let later = gate.admit(folder, now: now.addingTimeInterval(FolderHandoffGate.window + 0.1))
        #expect(first)
        #expect(!again)
        #expect(other)
        #expect(later)
    }
}
