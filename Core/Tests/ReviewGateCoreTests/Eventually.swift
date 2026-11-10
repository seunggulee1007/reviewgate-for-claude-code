import Foundation
import Testing

/// Waits on the main actor until `condition` holds, polling every 5 ms; records an issue at the caller if it never does.
///
/// A passing test returns as soon as the condition holds, so the budget only bounds a failing one — and it is wide on
/// purpose: these waits had 0.5–2 s (or a fixed 20 ms, or 50 yields), and a busy CI runner holds the main actor and the
/// cooperative pool for seconds. The budget is counted in polls, not read off a clock: a stall of the whole process holds
/// the polls up with it, so it is never used up while what the test waits for could not run either (a clock deadline
/// failed here after one such stall, with the awaited timer due right behind the poll). Only a positive wait belongs
/// here; a check that something did not happen keeps its own short wait.
@MainActor
func eventually(timeout: Duration = .seconds(30), sourceLocation: SourceLocation = #_sourceLocation,
                _ condition: () -> Bool) async {
    let interval = Duration.milliseconds(5)
    for _ in 0..<Int(timeout / interval) {
        if condition() { return }
        do { try await Task.sleep(for: interval) } catch { return }
    }
    if condition() { return }
    Issue.record("the condition did not hold after \(timeout) of polling", sourceLocation: sourceLocation)
}
