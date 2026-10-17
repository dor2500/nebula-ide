; Nebula IDE installer - system-wide in Program Files (needs administrator). Supports silent install with /S.
Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel admin
ManifestDPIAware true

!include "MUI2.nsh"
!include "x64.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define APP       "Nebula IDE"
!define EXE       "Nebula.exe"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\NebulaIDE"

Name "${APP}"
OutFile "${OUT}"
InstallDir "$PROGRAMFILES64\${APP}"
InstallDirRegKey HKLM "Software\NebulaIDE" "InstallDir"
BrandingText "${APP} ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APP}"
VIAddVersionKey "FileDescription" "${APP} Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "MIT License"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TEXT "This will install ${APP} ${VERSION} on your computer.$\r$\n$\r$\nNebula is an agent-first code editor built on VSCodium, with Claude as the agent.$\r$\n$\r$\nClick Next to continue."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Launch ${APP}"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchAsUser
!define MUI_COMPONENTSPAGE_SMALLDESC

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${LICENSE}"
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "${APP} requires 64-bit Windows." /SD IDOK
    Abort
  ${EndIf}
  SetRegView 64
FunctionEnd

; Launch the app as the signed-in user (not elevated) from the finish page.
Function LaunchAsUser
  Exec '"$WINDIR\explorer.exe" "$INSTDIR\${EXE}"'
FunctionEnd

Section "!${APP}" SecCore
  SectionIn RO
  SetShellVarContext current ; $LOCALAPPDATA must be the user's folder for the check below
  nsExec::Exec 'taskkill /F /IM ${EXE}'
  Sleep 800

  ; Earlier versions installed per user under AppData\Local\Programs - remove that copy (settings are kept).
  ReadRegStr $0 HKCU "${UNINSTKEY}" "InstallLocation"
  ${If} $0 == "$LOCALAPPDATA\Programs\${APP}"
  ${AndIf} $0 != $INSTDIR
    DetailPrint "Removing the previous per-user installation from $0"
    RMDir /r "$0"
    DeleteRegKey HKCU "${UNINSTKEY}"
    DeleteRegKey HKCU "Software\NebulaIDE"
    DeleteRegKey HKCU "Software\Classes\*\shell\NebulaIDE"
    DeleteRegKey HKCU "Software\Classes\Directory\shell\NebulaIDE"
    DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\NebulaIDE"
    Delete "$SMPROGRAMS\${APP}.lnk"
    Delete "$DESKTOP\${APP}.lnk"
  ${EndIf}
  SetShellVarContext all

  SetOutPath "$INSTDIR"
  File /r "${SRC}\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0 SW_SHOWNORMAL "" "Agent-first code editor"

  WriteRegStr HKLM "Software\NebulaIDE" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayName" "${APP}"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTKEY}" "Publisher" "Nebula IDE contributors"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKLM "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTKEY}" "URLInfoAbout" "https://github.com/dor2500/nebula-ide"
  WriteRegStr HKLM "${UNINSTKEY}" "HelpLink" "https://github.com/dor2500/nebula-ide/issues"
  WriteRegStr HKLM "${UNINSTKEY}" "URLUpdateInfo" "https://github.com/dor2500/nebula-ide/releases"
  WriteRegStr HKLM "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKLM "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKLM "${UNINSTKEY}" "EstimatedSize" $0
SectionEnd

Section "Desktop shortcut" SecDesktop
  SetShellVarContext all
  CreateShortcut "$DESKTOP\${APP}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
SectionEnd

Section "Add $\"Open with ${APP}$\" to Explorer" SecContext
  WriteRegStr HKLM "Software\Classes\*\shell\NebulaIDE" "" "Open with ${APP}"
  WriteRegStr HKLM "Software\Classes\*\shell\NebulaIDE" "Icon" "$INSTDIR\${EXE}"
  WriteRegStr HKLM "Software\Classes\*\shell\NebulaIDE\command" "" '"$INSTDIR\${EXE}" "%1"'
  WriteRegStr HKLM "Software\Classes\Directory\shell\NebulaIDE" "" "Open with ${APP}"
  WriteRegStr HKLM "Software\Classes\Directory\shell\NebulaIDE" "Icon" "$INSTDIR\${EXE}"
  WriteRegStr HKLM "Software\Classes\Directory\shell\NebulaIDE\command" "" '"$INSTDIR\${EXE}" "%V"'
  WriteRegStr HKLM "Software\Classes\Directory\Background\shell\NebulaIDE" "" "Open with ${APP}"
  WriteRegStr HKLM "Software\Classes\Directory\Background\shell\NebulaIDE" "Icon" "$INSTDIR\${EXE}"
  WriteRegStr HKLM "Software\Classes\Directory\Background\shell\NebulaIDE\command" "" '"$INSTDIR\${EXE}" "%V"'
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecCore} "The editor and the Claude agent (required)."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "A shortcut on the desktop for all users."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecContext} "Right-click a file or folder to open it in ${APP}."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Function un.onInit
  SetRegView 64
FunctionEnd

Section "Uninstall"
  SetShellVarContext all
  nsExec::Exec 'taskkill /F /IM ${EXE}'
  Sleep 800
  Delete "$SMPROGRAMS\${APP}.lnk"
  Delete "$DESKTOP\${APP}.lnk"
  DeleteRegKey HKLM "Software\Classes\*\shell\NebulaIDE"
  DeleteRegKey HKLM "Software\Classes\Directory\shell\NebulaIDE"
  DeleteRegKey HKLM "Software\Classes\Directory\Background\shell\NebulaIDE"
  DeleteRegKey HKLM "Software\NebulaIDE"
  DeleteRegKey HKLM "${UNINSTKEY}"
  RMDir /r "$INSTDIR"
SectionEnd
