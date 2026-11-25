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
