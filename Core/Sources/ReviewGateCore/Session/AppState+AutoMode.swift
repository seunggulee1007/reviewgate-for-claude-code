import Foundation

// MARK: wave4b w4b-auto
// docs/PROTOCOL.md §39.5: picking a permission mode from the composer or the HUD. While Claude works the engine takes a
// switch among default / acceptEdits / auto at once (the CLI applies it from its next tool call); one into or out of plan
// mode, and any while the turn's changes are collected, waits for the turn's end. A refused switch (a model without auto
// mode) goes back to the mode the engine runs and says why.

extension AppState {
    /// A session is open: the mode can be picked (now, or for after the turn).
    public var canPickPermissionMode: Bool { sessionInfo.open }

    /// §39.5: the engine takes a switch to `mode` now — idle, or while a turn runs a switch that neither enters nor leaves
    /// plan mode. Never while a session starts or a turn's changes are collected / reverted (`session_busy`).
    public func canSetPermissionMode(to mode: PermissionMode) -> Bool {
        if canSetPermissionMode { return true }
        guard sessionInfo.open, isRunning, !isStarting, !isSnapshotting, !isReverting else { return false }
        return mode != .plan && permissionMode != .plan
    }

    /// The composer / HUD pick: switches now when the engine can take it (idle, or default / acceptEdits / auto while Claude
    /// works — from its next step, as Shift+Tab in the terminal), else waits for the turn to end. Picking the current mode
    /// while one waits drops the waiting one.
    public func pickPermissionMode(_ mode: PermissionMode) {
        guard canPickPermissionMode else { return }
        permissionModeRefusal = nil
        if canSetPermissionMode(to: mode) {
            scheduledPermissionMode = nil
            requestPermissionMode(mode)
        } else {
            scheduledPermissionMode = mode == permissionMode ? nil : mode
        }
    }

    /// `set_permission_mode` as request/reply: the mode shows at once and is remembered for the project; a refusal puts
    /// the previous mode back and keeps the reason in `permissionModeRefusal` — `session_busy` (the turn's changes began to
    /// be collected meanwhile) makes the pick wait for the turn's end instead.
    public func requestPermissionMode(_ mode: PermissionMode) {
        guard mode != permissionMode, canSetPermissionMode(to: mode) else { return }
        let previous = permissionMode
        let key = projectURL.map(AppSettings.projectKey)
        state.session.permissionMode = mode
        AppSettings.setPermissionMode(mode, root: key, defaults: permsDefaults)
        let command = EngineCommand.setPermissionMode(mode: mode)
        if requestSink == nil, let commandSink {
            commandSink(command)
            return
        }
        Task {
            do {
                try await self.request(command)
                if mode == .auto { self.autoModeUnavailable = false }   // wave6 w6-terminal (§44.1): it runs after all
            } catch let error as EngineClientError where error.refusalCode == "session_busy" {
                self.permissionModeWaits(mode: mode, previous: previous, key: key)
            } catch let error as EngineClientError {
                self.permissionModeRefused(mode: mode, previous: previous, key: key, text: error.userMessage, code: error.refusalCode)
            } catch {
                self.permissionModeRefused(mode: mode, previous: previous, key: key, text: error.localizedDescription, code: nil)
            }
        }
    }

    /// The engine could not take the switch now (`session_busy`): the mode it runs shows again and the pick waits for the
    /// turn's end, as one made while the engine is busy does (the snapshot that ends the busy state sends it).
    func permissionModeWaits(mode: PermissionMode, previous: PermissionMode, key: String?) {
        if state.session.permissionMode == mode { state.session.permissionMode = previous }
        AppSettings.setPermissionMode(previous, root: key, defaults: permsDefaults)
        scheduledPermissionMode = mode == previous ? nil : mode
    }

    /// The engine kept its mode: show that one again and say why — for auto mode the model cannot run, also as the
    /// chat's gray row (a notice: no banner, no paused queue).
    func permissionModeRefused(mode: PermissionMode, previous: PermissionMode, key: String?, text: String, code: String?) {
        if state.session.permissionMode == mode { state.session.permissionMode = previous }
        AppSettings.setPermissionMode(previous, root: key, defaults: permsDefaults)
        permissionModeRefusal = text
        if code == "auto_mode_unavailable" {
            recordFailure(text, fatal: false, scope: .session, detail: EngineErrorDetail(code: code))
        }
    }

    /// After every snapshot: a mode picked during the turn goes out once the session is idle; another project or a closed
    /// session drops it.
    func applyScheduledPermissionMode(previousProject: String?) {
        guard let mode = scheduledPermissionMode else { return }
        if !state.session.open || state.project?.path != previousProject && previousProject != nil {
            scheduledPermissionMode = nil
            return
        }
        guard canSetPermissionMode else { return }
        scheduledPermissionMode = nil
        requestPermissionMode(mode)
    }
}
