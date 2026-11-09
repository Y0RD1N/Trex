; Standalone per-user Browser installer. The build must provide a real staged
; payload; this template never manufactures, downloads or executes a runtime.
Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma

!include MUI2.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!include "${__FILEDIR__}\trex-browser.nsh"

!ifndef TREX_BROWSER_PAYLOAD_DIR
  !error "Pass /DTREX_BROWSER_PAYLOAD_DIR=<absolute staged browser payload directory>"
!endif
!ifndef TREX_BROWSER_OUTFILE
  !error "Pass /DTREX_BROWSER_OUTFILE=<absolute setup.exe output path>"
!endif
!ifndef TREX_BROWSER_VERSION
  !define TREX_BROWSER_VERSION "0.2.0"
!endif
!ifndef TREX_BROWSER_PRODUCT_NAME
  !define TREX_BROWSER_PRODUCT_NAME "Trex Browser"
!endif
!ifndef TREX_BROWSER_DEFAULT_DIR
  !define TREX_BROWSER_DEFAULT_DIR "$LOCALAPPDATA\Programs\Trex Browser"
!endif
!ifndef TREX_BROWSER_REGISTRY_KEY
  !define TREX_BROWSER_REGISTRY_KEY "Software\com.trex.browser\Install"
!endif
!ifndef TREX_BROWSER_UNINSTALL_KEY
  !define TREX_BROWSER_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.trex.browser"
!endif

Name "${TREX_BROWSER_PRODUCT_NAME}"
OutFile "${TREX_BROWSER_OUTFILE}"
InstallDir "${TREX_BROWSER_DEFAULT_DIR}"
BrandingText "Trex Browser"
ShowInstDetails show
ShowUninstDetails show

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  SetShellVarContext current
  SetRegView 64
  StrCpy $TrexBrowserSelected 1
  ; NSIS applies /D before .onInit and removes it from $CMDLINE. Read the raw
  ; OS command line so explicit /D wins even when it names the default directory.
  ClearErrors
  System::Call 'kernel32::GetCommandLineW() w .r0'
  ${GetOptions} $0 "/D=" $1
  ${If} ${Errors}
    ReadRegStr $0 HKCU "${TREX_BROWSER_REGISTRY_KEY}" "InstallDir"
    ${If} $0 != ""
      System::Call 'kernel32::GetFullPathNameW(w r0, i ${NSIS_MAX_STRLEN}, w .r1, p 0) i .r2'
      ${If} $0 == $1
        StrCpy $INSTDIR $0
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ClearErrors
FunctionEnd

Section "Trex Browser"
  StrCpy $TrexBrowserFailed 0
  Push "$INSTDIR\uninstall-trex-browser.exe"
  Call TrexBrowserCheckFile
  Call TrexBrowserFailIfNeeded
  Call TrexBrowserPrepare
  SetOutPath "$INSTDIR"
  File "/oname=trex-browser.payload" "${TREX_BROWSER_PAYLOAD_DIR}\trex-browser.exe"
  SetOutPath "$INSTDIR\trex-browser-runtime.payload"
  File /r "${TREX_BROWSER_PAYLOAD_DIR}\trex-browser-runtime\*"
  SetOutPath "$INSTDIR"
  Call TrexBrowserInstall
  ClearErrors
  WriteUninstaller "$INSTDIR\uninstall-trex-browser.exe"
  ${If} ${Errors}
    SetErrorLevel 2
    Abort "No se pudo crear el desinstalador de Trex Browser."
  ${EndIf}
  ; The CLI resolver reads this exact 64-bit HKCU value. Optional app siblings
  ; never register here. Publish only a successfully promoted installation.
  SetRegView 64
  WriteRegStr HKCU "${TREX_BROWSER_REGISTRY_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${TREX_BROWSER_UNINSTALL_KEY}" "DisplayName" "${TREX_BROWSER_PRODUCT_NAME}"
  WriteRegStr HKCU "${TREX_BROWSER_UNINSTALL_KEY}" "DisplayVersion" "${TREX_BROWSER_VERSION}"
  WriteRegStr HKCU "${TREX_BROWSER_UNINSTALL_KEY}" "Publisher" "Trex"
  WriteRegStr HKCU "${TREX_BROWSER_UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${TREX_BROWSER_UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\uninstall-trex-browser.exe$\"'
  WriteRegStr HKCU "${TREX_BROWSER_UNINSTALL_KEY}" "QuietUninstallString" '$\"$INSTDIR\uninstall-trex-browser.exe$\" /S'
  WriteRegDWORD HKCU "${TREX_BROWSER_UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${TREX_BROWSER_UNINSTALL_KEY}" "NoRepair" 1
  ${If} ${Errors}
    SetErrorLevel 2
    Abort "No se pudo registrar Trex Browser. Vuelve a ejecutar el instalador."
  ${EndIf}
SectionEnd

Function un.onInit
  SetShellVarContext current
  SetRegView 64
FunctionEnd

Section "Uninstall"
  Call un.TrexBrowserRemove
  ClearErrors
  Delete "$INSTDIR\uninstall-trex-browser.exe"
  ${If} ${Errors}
    SetErrorLevel 2
    Abort "No se pudo quitar el desinstalador de Trex Browser."
  ${EndIf}
  ; An older installation must not unregister a newer installation at another
  ; /D path. Delete only owned values; retain any unrelated registry values.
  ReadRegStr $0 HKCU "${TREX_BROWSER_REGISTRY_KEY}" "InstallDir"
  ${If} $0 == $INSTDIR
    DeleteRegValue HKCU "${TREX_BROWSER_REGISTRY_KEY}" "InstallDir"
    DeleteRegKey /ifempty HKCU "${TREX_BROWSER_REGISTRY_KEY}"
  ${EndIf}
  ReadRegStr $0 HKCU "${TREX_BROWSER_UNINSTALL_KEY}" "InstallLocation"
  ${If} $0 == $INSTDIR
    DeleteRegValue HKCU "${TREX_BROWSER_UNINSTALL_KEY}" "DisplayName"
    DeleteRegValue HKCU "${TREX_BROWSER_UNINSTALL_KEY}" "DisplayVersion"
    DeleteRegValue HKCU "${TREX_BROWSER_UNINSTALL_KEY}" "Publisher"
    DeleteRegValue HKCU "${TREX_BROWSER_UNINSTALL_KEY}" "InstallLocation"
    DeleteRegValue HKCU "${TREX_BROWSER_UNINSTALL_KEY}" "UninstallString"
    DeleteRegValue HKCU "${TREX_BROWSER_UNINSTALL_KEY}" "QuietUninstallString"
    DeleteRegValue HKCU "${TREX_BROWSER_UNINSTALL_KEY}" "NoModify"
    DeleteRegValue HKCU "${TREX_BROWSER_UNINSTALL_KEY}" "NoRepair"
    DeleteRegKey /ifempty HKCU "${TREX_BROWSER_UNINSTALL_KEY}"
  ${EndIf}
  ; No recursive deletion of INSTDIR or any profile/artifact/credential path.
  RMDir "$INSTDIR"
SectionEnd
