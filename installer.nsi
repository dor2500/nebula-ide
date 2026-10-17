; Nebula IDE installer - per-user, no admin rights needed. Supports silent install with /S.
Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user

!include "MUI2.nsh"

!define APP      "Nebula IDE"
!define EXE      "Nebula.exe"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\NebulaIDE"

Name "${APP}"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\Programs\${APP}"
InstallDirRegKey HKCU "Software\NebulaIDE" "InstallDir"
BrandingText "${APP} ${VERSION}"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Launch ${APP}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  ; close a running copy so files can be replaced
  nsExec::Exec 'taskkill /F /IM ${EXE}'
  SetOutPath "$INSTDIR"
  File /r "${SRC}\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateShortcut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\${EXE}"
  CreateShortcut "$DESKTOP\${APP}.lnk" "$INSTDIR\${EXE}"

  ; "Open with Nebula IDE" in Explorer context menus
  WriteRegStr HKCU "Software\Classes\*\shell\NebulaIDE" "" "Open with ${APP}"
  WriteRegStr HKCU "Software\Classes\*\shell\NebulaIDE" "Icon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "Software\Classes\*\shell\NebulaIDE\command" "" '"$INSTDIR\${EXE}" "%1"'
  WriteRegStr HKCU "Software\Classes\Directory\shell\NebulaIDE" "" "Open with ${APP}"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NebulaIDE" "Icon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NebulaIDE\command" "" '"$INSTDIR\${EXE}" "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NebulaIDE" "" "Open with ${APP}"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NebulaIDE" "Icon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NebulaIDE\command" "" '"$INSTDIR\${EXE}" "%V"'

  WriteRegStr HKCU "Software\NebulaIDE" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "Nebula"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM ${EXE}'
  Delete "$SMPROGRAMS\${APP}.lnk"
  Delete "$DESKTOP\${APP}.lnk"
  DeleteRegKey HKCU "Software\Classes\*\shell\NebulaIDE"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\NebulaIDE"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\NebulaIDE"
  DeleteRegKey HKCU "Software\NebulaIDE"
  DeleteRegKey HKCU "${UNINSTKEY}"
  RMDir /r "$INSTDIR"
SectionEnd
