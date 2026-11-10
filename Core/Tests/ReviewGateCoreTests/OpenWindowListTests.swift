import Foundation
import Testing
@testable import ReviewGateCore

/// polish P1-chrome-02 / P5-sheets-52 (docs/PROTOCOL.md §55.7): closing the last window, then quitting, reopens its project.
@Suite struct OpenWindowListTests {
    private let api = AppSettings.OpenWindowState(path: "/work/acme-api", frame: nil)

    @Test func theWindowsWithAProjectInOrder() {
        #expect(OpenWindowList.toWrite([api, nil], terminating: false) == [api])
    }

    @Test func theLastWindowGoneOrQuittingKeepsTheListWritten() {
        #expect(OpenWindowList.toWrite([], terminating: false) == nil)
        #expect(OpenWindowList.toWrite([api], terminating: true) == nil)
    }

    @Test func aWindowThatClosedItsProjectWritesTheShorterList() {
        #expect(OpenWindowList.toWrite([nil], terminating: false) == [])
    }
}
