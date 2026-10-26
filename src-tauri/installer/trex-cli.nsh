!ifndef TREX_CLI_INCLUDED
!define TREX_CLI_INCLUDED
!include LogicLib.nsh
!include nsDialogs.nsh
!include FileFunc.nsh

; A non-secret preference outside Tauri's app-data/removal registry subtree.
; The override is used only by the isolated installer verification script.
!ifndef TREX_CLI_REGISTRY_KEY
  !define TREX_CLI_REGISTRY_KEY "Software\com.trex.app\Installer"
!endif

!ifndef TREX_BROWSER_INCLUDED
!define TREX_BROWSER_INCLUDED
!include LogicLib.nsh
!include FileFunc.nsh

; This key is shared with the optional CLI, but the two DWORDs are independent.
!ifndef TREX_CLI_REGISTRY_KEY
  !define TREX_CLI_REGISTRY_KEY "Software\com.trex.app\Installer"
!endif

Var TrexBrowserSelected
!ifndef TREX_BROWSER_ONLY
Var TrexBrowserInitialized
Var TrexBrowserCheckbox
!endif
Var TrexBrowserFailed
Var TrexBrowserFailurePath
Var TrexBrowserOldExe
Var TrexBrowserOldRuntime
Var TrexBrowserNewExe
Var TrexBrowserNewRuntime

!ifndef TREX_BROWSER_ONLY
Function TrexBrowserInitialize
  ${If} $TrexBrowserInitialized == 1
    ClearErrors
    Return
  ${EndIf}
  StrCpy $TrexBrowserInitialized 1
  StrCpy $TrexBrowserSelected 0
  ReadRegDWORD $0 HKCU "${TREX_CLI_REGISTRY_KEY}" "InstallBrowser"
  ${IfNot} ${Errors}
  ${AndIf} $0 == 1
    StrCpy $TrexBrowserSelected 1
  ${EndIf}
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/TREXBROWSER=" $1
  ${IfNot} ${Errors}
    ${If} $1 == "1"
      StrCpy $TrexBrowserSelected 1
    ${ElseIf} $1 == "0"
      StrCpy $TrexBrowserSelected 0
    ${Else}
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
  ClearErrors
FunctionEnd
!endif

; Validate every entry before changing either live asset. Reparse points are
; rejected, including ancestors of INSTDIR. An exclusive DELETE/read/write open
; detects running/locked files without stopping a browser or scheduling deletion.
; Both installer and uninstaller use the same validation and removal code.
!macro TrexBrowserSafetyFunctions PREFIX
Function ${PREFIX}TrexBrowserCheckFile
  Exch $0
  Push $1
  Push $2
  System::Call 'kernel32::GetFileAttributesW(w r0) i .r1 ?e'
  Pop $2
  ${If} $1 == -1
    ${If} $2 != 2
    ${AndIf} $2 != 3
      StrCpy $TrexBrowserFailed 1
      StrCpy $TrexBrowserFailurePath $0
    ${EndIf}
  ${Else}
    IntOp $2 $1 & 0x411 ; directory, reparse point or read-only
    ${If} $2 != 0
      StrCpy $TrexBrowserFailed 1
      StrCpy $TrexBrowserFailurePath $0
    ${Else}
      System::Call 'kernel32::CreateFileW(w r0, i 0xC0010000, i 0, p 0, i 3, i 0, p 0) p .r2'
      ${If} $2 == -1
        StrCpy $TrexBrowserFailed 1
        StrCpy $TrexBrowserFailurePath $0
      ${Else}
        System::Call 'kernel32::CloseHandle(p r2)'
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function ${PREFIX}TrexBrowserCheckTree
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  System::Call 'kernel32::GetFileAttributesW(w r0) i .r1 ?e'
  Pop $2
  ${If} $1 == -1
    ${If} $2 != 2
    ${AndIf} $2 != 3
      StrCpy $TrexBrowserFailed 1
      StrCpy $TrexBrowserFailurePath $0
    ${EndIf}
    Goto tree_done
  ${EndIf}
  IntOp $2 $1 & 0x410
  ${If} $2 != 16
    StrCpy $TrexBrowserFailed 1
    StrCpy $TrexBrowserFailurePath $0
    Goto tree_done
  ${EndIf}
  System::Call 'kernel32::CreateFileW(w r0, i 0x10001, i 0, p 0, i 3, i 0x02000000, p 0) p .r3'
  ${If} $3 == -1
    StrCpy $TrexBrowserFailed 1
    StrCpy $TrexBrowserFailurePath $0
    Goto tree_done
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r3)'
  FindFirst $1 $2 "$0\*"
  ${DoWhile} $2 != ""
    ${If} $2 != "."
    ${AndIf} $2 != ".."
      System::Call 'kernel32::GetFileAttributesW(w "$0\$2") i .r3'
      IntOp $4 $3 & 0x10
      Push "$0\$2"
      ${If} $4 != 0
        Call ${PREFIX}TrexBrowserCheckTree
      ${Else}
        Call ${PREFIX}TrexBrowserCheckFile
      ${EndIf}
    ${EndIf}
    ${If} $TrexBrowserFailed == 1
      ${ExitDo}
    ${EndIf}
    FindNext $1 $2
  ${Loop}
  FindClose $1
  tree_done:
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function ${PREFIX}TrexBrowserCheckAncestors
  Push $0
  Push $1
  Push $2
  ; Canonicalize absolute paths before a fresh target exists.
  System::Call 'kernel32::GetFullPathNameW(w "$INSTDIR", i ${NSIS_MAX_STRLEN}, w .r0, p 0) i .r2'
  ${If} $0 != $INSTDIR
  ${OrIf} $INSTDIR == ""
    StrCpy $TrexBrowserFailed 1
    StrCpy $TrexBrowserFailurePath $INSTDIR
    Goto ancestors_done
  ${EndIf}
  System::Call 'kernel32::GetFullPathNameW(w "$0\..", i ${NSIS_MAX_STRLEN}, w .r1, p 0) i .r2'
  ${If} $0 == $1
    StrCpy $TrexBrowserFailed 1
    StrCpy $TrexBrowserFailurePath $INSTDIR
    Goto ancestors_done
  ${EndIf}
  ${Do}
    System::Call 'kernel32::GetFileAttributesW(w r0) i .r1 ?e'
    Pop $2
    ${If} $1 != -1
      IntOp $2 $1 & 0x410
      ${If} $2 != 16
        StrCpy $TrexBrowserFailed 1
        StrCpy $TrexBrowserFailurePath $0
        ${ExitDo}
      ${EndIf}
    ${Else}
      ${If} $2 != 2
      ${AndIf} $2 != 3
        StrCpy $TrexBrowserFailed 1
        StrCpy $TrexBrowserFailurePath $0
        ${ExitDo}
      ${EndIf}
    ${EndIf}
    System::Call 'kernel32::GetFullPathNameW(w "$0\..", i ${NSIS_MAX_STRLEN}, w .r1, p 0) i .r2'
    ${If} $0 == $1
      ${ExitDo}
    ${EndIf}
    StrCpy $0 $1
  ${Loop}
  ancestors_done:
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function ${PREFIX}TrexBrowserFailIfNeeded
  ${If} $TrexBrowserFailed == 1
    SetErrorLevel 2
    Abort "No se pudo actualizar Trex Browser: $TrexBrowserFailurePath. Cierra las sesiones y comprueba los archivos antes de reintentar."
  ${EndIf}
  ClearErrors
FunctionEnd

Function ${PREFIX}TrexBrowserPreflight
  StrCpy $TrexBrowserFailed 0
  Call ${PREFIX}TrexBrowserCheckAncestors
  Call ${PREFIX}TrexBrowserFailIfNeeded
  Push "$INSTDIR\trex-browser.exe"
  Call ${PREFIX}TrexBrowserCheckFile
  Push "$INSTDIR\trex-browser-runtime"
  Call ${PREFIX}TrexBrowserCheckTree
  Push "$INSTDIR\trex-browser.payload"
  Call ${PREFIX}TrexBrowserCheckFile
  Push "$INSTDIR\trex-browser-runtime.payload"
  Call ${PREFIX}TrexBrowserCheckTree
  Push $0
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\trex-browser.exe.previous") i .r0'
  ${If} $0 != -1
    StrCpy $TrexBrowserFailed 1
    StrCpy $TrexBrowserFailurePath "$INSTDIR\trex-browser.exe.previous"
  ${EndIf}
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\trex-browser-runtime.previous") i .r0'
  ${If} $0 != -1
    StrCpy $TrexBrowserFailed 1
    StrCpy $TrexBrowserFailurePath "$INSTDIR\trex-browser-runtime.previous"
  ${EndIf}
  Pop $0
  Call ${PREFIX}TrexBrowserFailIfNeeded
FunctionEnd

Function ${PREFIX}TrexBrowserDeletePayload
  ClearErrors
  Delete "$INSTDIR\trex-browser.payload"
  IfFileExists "$INSTDIR\trex-browser-runtime.payload\*" 0 +2
    RMDir /r "$INSTDIR\trex-browser-runtime.payload"
  ${If} ${Errors}
    StrCpy $TrexBrowserFailed 1
    StrCpy $TrexBrowserFailurePath "$INSTDIR\trex-browser-runtime.payload"
    Call ${PREFIX}TrexBrowserFailIfNeeded
  ${EndIf}
FunctionEnd

Function ${PREFIX}TrexBrowserRemove
  Call ${PREFIX}TrexBrowserPreflight
  ; Only these program assets are owned here. User data lives outside INSTDIR.
  ClearErrors
  Delete "$INSTDIR\trex-browser.exe"
  IfFileExists "$INSTDIR\trex-browser-runtime\*" 0 +2
    RMDir /r "$INSTDIR\trex-browser-runtime"
  ${If} ${Errors}
    StrCpy $TrexBrowserFailed 1
    StrCpy $TrexBrowserFailurePath "$INSTDIR\trex-browser-runtime"
    Call ${PREFIX}TrexBrowserFailIfNeeded
  ${EndIf}
  Call ${PREFIX}TrexBrowserDeletePayload
FunctionEnd
!macroend
!insertmacro TrexBrowserSafetyFunctions ""
!insertmacro TrexBrowserSafetyFunctions "un."

Function TrexBrowserPrepare
  Call TrexBrowserPreflight
  ; Discard only validated inert resources before extraction, so an update
  ; cannot retain stale modules from a previous package.
  Call TrexBrowserDeletePayload
FunctionEnd

!macro TrexBrowserRequireFile PATH
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\${PATH}") i .r0'
  IntOp $1 $0 & 0x410
  ${If} $0 == -1
  ${OrIf} $1 != 0
    StrCpy $TrexBrowserFailed 1
    StrCpy $TrexBrowserFailurePath "$INSTDIR\${PATH}"
  ${EndIf}
!macroend

!macro TrexBrowserRequireDirectory PATH
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\${PATH}") i .r0'
  IntOp $1 $0 & 0x410
  ${If} $0 == -1
  ${OrIf} $1 != 16
    StrCpy $TrexBrowserFailed 1
    StrCpy $TrexBrowserFailurePath "$INSTDIR\${PATH}"
  ${EndIf}
!macroend

Function TrexBrowserValidatePayload
  Push $0
  Push $1
  !insertmacro TrexBrowserRequireFile "trex-browser.payload"
  !insertmacro TrexBrowserRequireFile "trex-browser-runtime.payload\node.exe"
  !insertmacro TrexBrowserRequireFile "trex-browser-runtime.payload\worker.mjs"
  !insertmacro TrexBrowserRequireFile "trex-browser-runtime.payload\package.json"
  !insertmacro TrexBrowserRequireFile "trex-browser-runtime.payload\package-lock.json"
  !insertmacro TrexBrowserRequireDirectory "trex-browser-runtime.payload\node_modules"
  !insertmacro TrexBrowserRequireDirectory "trex-browser-runtime.payload\ffmpeg"
  Pop $1
  Pop $0
  Call TrexBrowserFailIfNeeded
FunctionEnd

Function TrexBrowserRollback
  ; Reverse successful renames; never erase a live tree to make room. If a
  ; concurrent lock prevents restoration, .previous remains for recovery.
  ${If} $TrexBrowserNewRuntime == 1
    Rename "$INSTDIR\trex-browser-runtime" "$INSTDIR\trex-browser-runtime.payload"
  ${EndIf}
  ${If} $TrexBrowserNewExe == 1
    Rename "$INSTDIR\trex-browser.exe" "$INSTDIR\trex-browser.payload"
  ${EndIf}
  ${If} $TrexBrowserOldRuntime == 1
    Rename "$INSTDIR\trex-browser-runtime.previous" "$INSTDIR\trex-browser-runtime"
  ${EndIf}
  ${If} $TrexBrowserOldExe == 1
    Rename "$INSTDIR\trex-browser.exe.previous" "$INSTDIR\trex-browser.exe"
  ${EndIf}
  StrCpy $TrexBrowserFailed 1
  StrCpy $TrexBrowserFailurePath "$INSTDIR\trex-browser-runtime"
  Call TrexBrowserFailIfNeeded
FunctionEnd

Function TrexBrowserInstall
  Call TrexBrowserPreflight
  ${If} $TrexBrowserSelected == 0
    Call TrexBrowserRemove
    Return
  ${EndIf}
  Call TrexBrowserValidatePayload
  StrCpy $TrexBrowserOldExe 0
  StrCpy $TrexBrowserOldRuntime 0
  StrCpy $TrexBrowserNewExe 0
  StrCpy $TrexBrowserNewRuntime 0
  IfFileExists "$INSTDIR\trex-browser.exe" 0 browser_move_runtime
    ClearErrors
    Rename "$INSTDIR\trex-browser.exe" "$INSTDIR\trex-browser.exe.previous"
    ${If} ${Errors}
      Call TrexBrowserRollback
    ${EndIf}
    StrCpy $TrexBrowserOldExe 1
  browser_move_runtime:
  IfFileExists "$INSTDIR\trex-browser-runtime\*" 0 browser_promote
    ClearErrors
    Rename "$INSTDIR\trex-browser-runtime" "$INSTDIR\trex-browser-runtime.previous"
    ${If} ${Errors}
      Call TrexBrowserRollback
    ${EndIf}
    StrCpy $TrexBrowserOldRuntime 1
  browser_promote:
  ClearErrors
  Rename "$INSTDIR\trex-browser.payload" "$INSTDIR\trex-browser.exe"
  ${If} ${Errors}
    Call TrexBrowserRollback
  ${EndIf}
  StrCpy $TrexBrowserNewExe 1
  ClearErrors
  Rename "$INSTDIR\trex-browser-runtime.payload" "$INSTDIR\trex-browser-runtime"
  ${If} ${Errors}
    Call TrexBrowserRollback
  ${EndIf}
  StrCpy $TrexBrowserNewRuntime 1
  ClearErrors
  Delete "$INSTDIR\trex-browser.exe.previous"
  ${If} $TrexBrowserOldRuntime == 1
    RMDir /r "$INSTDIR\trex-browser-runtime.previous"
  ${EndIf}
  ${If} ${Errors}
    StrCpy $TrexBrowserFailed 1
    StrCpy $TrexBrowserFailurePath "$INSTDIR\trex-browser-runtime.previous"
    Call TrexBrowserFailIfNeeded
  ${EndIf}
  ClearErrors
FunctionEnd
!endif

!ifndef TREX_BROWSER_ONLY

Var TrexCliSelected
Var TrexCliInitialized
Var TrexCliCheckbox

Function TrexCliInitialize
  Call TrexBrowserInitialize
  ${If} $TrexCliInitialized == 1
    ClearErrors
    Return
  ${EndIf}
  StrCpy $TrexCliInitialized 1
  StrCpy $TrexCliSelected 0
  ClearErrors
  ReadRegDWORD $0 HKCU "${TREX_CLI_REGISTRY_KEY}" "InstallCli"
  ${IfNot} ${Errors}
  ${AndIf} $0 == 1
    StrCpy $TrexCliSelected 1
  ${EndIf}

  ; Explicit unattended opt-in/out; /S and /P alone never opt a new user in.
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/TREXCLI=" $1
  ${IfNot} ${Errors}
    ${If} $1 == "1"
      StrCpy $TrexCliSelected 1
    ${ElseIf} $1 == "0"
      StrCpy $TrexCliSelected 0
    ${Else}
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
  ClearErrors
FunctionEnd

Function TrexCliPageCreate
  Call TrexCliInitialize
  ${If} $PassiveMode == 1
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Componentes opcionales de Trex" "Elige Trex CLI y Trex Browser por separado."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${NSD_CreateCheckbox} 0 12u 100% 20u "Instalar Trex CLI (modelos con API key)"
  Pop $TrexCliCheckbox
  ${If} $TrexCliCheckbox == error
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${NSD_SetState} $TrexCliCheckbox $TrexCliSelected
  ${NSD_OnClick} $TrexCliCheckbox TrexCliSelectionChanged
  ${NSD_CreateLabel} 0 35u 100% 32u "Permite crear perfiles TREX1, TREX2 y conectar proveedores API. Las API keys se configuran después en Trex. Claude Code y Codex siguen disponibles."
  Pop $0
  ${NSD_CreateCheckbox} 0 80u 100% 20u "Instalar Trex Browser (navegador automatizado)"
  Pop $TrexBrowserCheckbox
  ${If} $TrexBrowserCheckbox == error
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${NSD_SetState} $TrexBrowserCheckbox $TrexBrowserSelected
  ${NSD_OnClick} $TrexBrowserCheckbox TrexBrowserSelectionChanged
  ${NSD_CreateLabel} 0 104u 100% 30u "Instala el comando Trex Browser y su runtime. Los perfiles y las credenciales se configuran después; no se abre ningún navegador durante la instalación."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function TrexCliPageLeave
  ${NSD_GetState} $TrexCliCheckbox $TrexCliSelected
  ${NSD_GetState} $TrexBrowserCheckbox $TrexBrowserSelected
FunctionEnd

Function TrexCliSelectionChanged
  Pop $0
  ${NSD_GetState} $TrexCliCheckbox $TrexCliSelected
FunctionEnd

Function TrexBrowserSelectionChanged
  Pop $0
  ${NSD_GetState} $TrexBrowserCheckbox $TrexBrowserSelected
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  Call TrexCliInitialize
  Call TrexBrowserPrepare
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Call TrexBrowserInstall
  ${If} $TrexCliSelected == 1
    ; The bundle contains an inert payload, never an always-installed CLI.
    ; CopyFileW has an exact destination filename (CopyFiles permits folders).
    System::Call 'kernel32::CopyFileW(w "$INSTDIR\trex-agent.payload", w "$INSTDIR\trex-agent.exe", i 0) i .r0'
    ${If} $0 == 0
      Delete "$INSTDIR\trex-agent.payload"
      SetErrorLevel 2
      Abort "No se pudo instalar Trex CLI. Cierra las sesiones Trex y vuelve a intentarlo."
    ${EndIf}
  ${Else}
    ; An explicit opt-out on maintenance removes only the executable.
    ClearErrors
    Delete "$INSTDIR\trex-agent.exe"
    ${If} ${Errors}
      Delete "$INSTDIR\trex-agent.payload"
      SetErrorLevel 2
      Abort "No se pudo quitar Trex CLI. Cierra las sesiones Trex y vuelve a intentarlo."
    ${EndIf}
  ${EndIf}
  ClearErrors
  Delete "$INSTDIR\trex-agent.payload"
  ${If} ${Errors}
    SetErrorLevel 2
    Abort "No se pudo limpiar el payload de Trex CLI. Vuelve a ejecutar el instalador."
  ${EndIf}
  ClearErrors
  WriteRegDWORD HKCU "${TREX_CLI_REGISTRY_KEY}" "InstallCli" $TrexCliSelected
  ${If} ${Errors}
    SetErrorLevel 2
    Abort "No se pudo guardar la opción de Trex CLI. Vuelve a ejecutar el instalador."
  ${EndIf}
  ClearErrors
  WriteRegDWORD HKCU "${TREX_CLI_REGISTRY_KEY}" "InstallBrowser" $TrexBrowserSelected
  ${If} ${Errors}
    SetErrorLevel 2
    Abort "No se pudo guardar la opción de Trex Browser. Vuelve a ejecutar el instalador."
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Call un.TrexBrowserPreflight
  ; No profile directory, credential store or API key is ever removed here.
  ClearErrors
  Delete "$INSTDIR\trex-agent.exe"
  ${If} ${Errors}
    SetErrorLevel 2
    Abort "No se pudo quitar Trex CLI. Cierra las sesiones Trex y vuelve a intentarlo."
  ${EndIf}
  ClearErrors
  Delete "$INSTDIR\trex-agent.payload"
  ${If} ${Errors}
    SetErrorLevel 2
    Abort "No se pudo quitar el payload de Trex CLI."
  ${EndIf}
  ; Keep the choice through Tauri's uninstall/reinstall update flow.
  Call un.TrexBrowserRemove
!macroend
!endif ; TREX_BROWSER_ONLY
!endif
