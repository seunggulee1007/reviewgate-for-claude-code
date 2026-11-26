; ReviewGate's additions to electron-builder 26's assisted NSIS installer (picked up as build/installer.nsh).
;
; The finish page, as electron-builder's own (assistedInstaller.nsh: "Run ReviewGate", started as this user), except for
; an update from the app: the app runs the installer shown, not silent - `/currentuser --updated`
; (src/main/updateInstall.ts INSTALLER_ARGS), so the progress and any "cannot be closed" / "failed to uninstall" box are
; on screen instead of 10-60 s of nothing and, for a file in use, a lone error box (docs/PROTOCOL.md 48, Windows).
; Such an update skips the finish page and starts ReviewGate again by itself, as the silent `--force-run` did; a double-clicked installer
; (no --updated) keeps the page and its checkbox.
!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function rgFinishPagePre
    ${if} ${isUpdated}
      Call StartApp
      Abort
    ${endif}
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_PRE rgFinishPagePre
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !insertmacro MUI_PAGE_FINISH
!macroend

; An update that does not install never leaves the user with nothing (docs/PROTOCOL.md 48, Windows). The apps up to
; 0.5.30 run every new installer silent (`/S /currentuser --updated --force-run`); reproduced on windows-latest, a file
; of the install held open by another program (an antivirus scan, a backup or indexing agent) made the old version's
; uninstaller fail, and electron-builder then showed "Failed to uninstall old application files" - even under /S, with
; no window of its own, behind the others - and quit without starting ReviewGate. While that box waited, every later
; [Install and Restart] started an installer that met its single-instance mutex and quit at once: ReviewGate closed and
; never came back, "ReviewGate X is still installed" each time. Now, for an update (--updated):
; - silent, the old uninstaller is run once more (its own five tries again), ReviewGate's own processes closed first;
; - when it still fails, no box under /S (it would hold the mutex), the box in front otherwise, then the installed (old)
;   ReviewGate is started again, `--updated` (past the launch guard of 0.5.31 and later) and the installer quits;
; - an installer that finds another one still open says so and starts ReviewGate again before it quits;
; - each step goes to %TEMP%\ReviewGate-update.log (UTF-16LE, one line each: `<version> <event> <detail>`), which the
;   next launch reads into its log and the "did not install" notice (src/main/updateInstallerLog.ts), then removes.
; (In customHeader: electron-builder inserts it once LogicLib and its own functions are there.)
!macro customHeader
!ifndef BUILD_UNINSTALLER
  Var rgLogLine
  Var rgBusy

  Function rgLog
    Push $0
    ClearErrors
    FileOpen $0 "$TEMP\ReviewGate-update.log" a
    ${ifNot} ${Errors}
      FileSeek $0 0 END
      FileWriteUTF16LE $0 "${VERSION} $rgLogLine$\r$\n"
      FileClose $0
    ${endif}
    ClearErrors
    Pop $0
  FunctionEnd

  ; The installed ReviewGate, started again as this user (the version that is still there).
  Function rgStartInstalled
    Exch $0
    ${if} ${FileExists} "$0\${APP_EXECUTABLE_FILENAME}"
      ${StdUtils.ExecShellAsUser} $1 "$0\${APP_EXECUTABLE_FILENAME}" "open" "--updated"
      StrCpy $rgLogLine "reopened $0\${APP_EXECUTABLE_FILENAME} ($1)"
    ${else}
      StrCpy $rgLogLine "reopened none ($0)"
    ${endif}
    Call rgLog
    Pop $0
  FunctionEnd

  ; Which file of $INSTDIR another program holds open without delete sharing (what keeps the uninstaller from moving
  ; it away), and which programs hold it (Windows' Restart Manager): "resources\app.asar by MsMpEng.exe 1234".
  Function rgFindBusy
    StrCpy $rgBusy ""
    InitPluginsDir
    File /oname=$PLUGINSDIR\rg-busy.ps1 "${BUILD_RESOURCES_DIR}\rg-busy.ps1"
    nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\rg-busy.ps1" "$INSTDIR"`
    Pop $0
    Pop $rgBusy
  FunctionEnd

  ; ReviewGate's own processes (anything run from $INSTDIR), force-closed as electron-builder's own check does.
  Function rgStopInstalled
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C "Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')} | % { Stop-Process -Id $$_.ProcessId -Force }"`
    Pop $0
  FunctionEnd
!endif
!macroend

!macro rgLog TEXT
  StrCpy $rgLogLine "${TEXT}"
  Call rgLog
!macroend

!macro preInit
  !ifndef BUILD_UNINSTALLER
    !insertmacro rgLog "start $CMDLINE"
    ${if} ${isUpdated}
      ; electron-builder's single-instance check (right after this) quits at once and silently when another installer of
      ; ReviewGate is open - one left waiting on a box by an earlier update, say.
      System::Call 'kernel32::OpenMutex(i 0x00100000, i 0, t "${APP_GUID}") p .r0'
      ${if} $0 != 0
        System::Call 'kernel32::CloseHandle(p r0)'
        !insertmacro rgLog "failed another-installer"
        ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
        ${if} $0 == ""
          ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
        ${endif}
        ; The app that started this installer is still quitting (from 0.5.35 it watches its installer for 1.5 s, and
        ; reopens itself when that one ends at once): started now, this launch would hand itself to it and go.
        Sleep 4000
        Push $0
        Call rgStartInstalled
      ${endif}
    ${endif}
  !endif
!macroend

!macro customInit
  !insertmacro rgLog "mode $installMode $INSTDIR"
!macroend

!macro customInstall
  !insertmacro rgLog "installed $INSTDIR"
!macroend

; In place of electron-builder's check after the old version's uninstaller (installUtil.nsh handleUninstallResult): it
; could not be started → install over it, as before; it failed → see above.
!macro customUnInstallCheck
  ${if} ${Errors}
    !insertmacro rgLog "uninstall-old not-started"
  ${elseif} $R0 != 0
    !insertmacro rgLog "uninstall-old failed $R0"
    ${if} ${Silent}
    ${andIf} ${isUpdated}
      ; Once more, ReviewGate's own processes closed first (one opened again meanwhile holds its files too).
      Sleep 2000
      Call rgStopInstalled
      ; (installUtil.nsh's `uninstallOldVersion` macro is defined after this check; its function is called directly)
      Push SHELL_CONTEXT
      Call uninstallOldVersion
      ${if} ${Errors}
        StrCpy $R0 0
      ${endif}
      !insertmacro rgLog "uninstall-old retry: $R0"
    ${endif}
    ${if} $R0 != 0
      Call rgFindBusy
      !insertmacro rgLog "failed uninstall-old $R0 $rgBusy"
      ${ifNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION|MB_TOPMOST|MB_SETFOREGROUND "$(uninstallFailed): $R0$\r$\n$\r$\n$rgBusy"
      ${endif}
      ${if} ${isUpdated}
        Push $INSTDIR
        Call rgStartInstalled
      ${endif}
      SetErrorLevel 2
      Quit
    ${endif}
  ${endif}
!macroend
