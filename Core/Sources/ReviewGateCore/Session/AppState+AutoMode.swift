import Foundation

// MARK: wave4b w4b-auto
// docs/PROTOCOL.md §39.5: picking a permission mode from the composer or the HUD. While Claude works the engine refuses
// `set_permission_mode` (`session_busy`), so the pick waits for the turn's end; a refused switch (a model without auto
// mode) goes back to the mode the engine runs and says why.

extension AppState {
    /// A session is open: the mode can be picked (now, or for after the turn).
    public var canPickPermissionMode: Bool { sessionInfo.open }

    /// The composer / HUD pick: switches now when idle, else waits for the turn to end. Picking the current mode while one
    /// waits drops the waiting one.
    public func pickPermissionMode(_ mode: PermissionMode) {
        guard canPickPermissionMode else { return }
        permissionModeRefusal = nil
        if canSetPermissionMode {
            scheduledPermissionMode = nil
            requestPermissionMode(mode)
        } else {
            scheduledPermissionMode = mode == permissionMode ? nil : mode
        }
    }

    /// `set_permission_mode` as request/reply: the mode shows at once and is remembered for the project; a refusal puts
    /// the previous mode back and keeps the reason in `permissionModeRefusal`.
    public func requestPermissionMode(_ mode: PermissionMode) {
        guard mode != permissionMode, canSetPermissionMode else { return }
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
            } catch let error as EngineClientError {
                self.permissionModeRefused(mode: mode, previous: previous, key: key, text: error.userMessage, code: error.refusalCode)
            } catch {
                self.permissionModeRefused(mode: mode, previous: previous, key: key, text: error.localizedDescription, code: nil)
            }
        }
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
