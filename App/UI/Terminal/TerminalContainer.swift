import AppKit
import SwiftUI

// MARK: terminal-chat (§57.5)
/// Shows a `TerminalHost`'s view. The host owns the view and its PTY, so SwiftUI tearing this down (another tab, the PRs
/// tab, a hidden panel) never ends the process; a restart's fresh view (`generation`) is attached in its place.
struct TerminalContainer: NSViewRepresentable {
    let host: TerminalHost

    func makeNSView(context: Context) -> NSView {
        let container = NSView()
        attach(host.view, to: container)
        return container
    }

    func updateNSView(_ container: NSView, context: Context) {
        _ = host.generation   // observed: a restart's new view replaces the old one
        if container.subviews.first !== host.view {
            container.subviews.forEach { $0.removeFromSuperview() }
            attach(host.view, to: container)
        }
    }

    static func dismantleNSView(_ container: NSView, coordinator: ()) {
        // The view may have moved into another container already; only let go of what is still here.
        container.subviews.forEach { $0.removeFromSuperview() }
    }

    private func attach(_ v: NSView, to container: NSView) {
        v.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(v)
        NSLayoutConstraint.activate([
            v.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            v.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            v.topAnchor.constraint(equalTo: container.topAnchor),
            v.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
    }
}
