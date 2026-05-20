; Fredo installer hooks — add install dir to system PATH
!macro customInstall
  ; Add the install directory to the system PATH so `fredo` is available in any terminal
  EnVar::SetHKLM
  EnVar::AddValue "PATH" "$INSTDIR"
  Pop $0
!macroend

!macro customUnInstall
  ; Remove install directory from PATH on uninstall
  EnVar::SetHKLM
  EnVar::DeleteValue "PATH" "$INSTDIR"
  Pop $0
!macroend
