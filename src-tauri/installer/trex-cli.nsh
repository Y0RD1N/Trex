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

Var TrexCliSelected
Var TrexCliInitialized
Var TrexCliCheckbox

Function TrexCliInitialize
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
  !insertmacro MUI_HEADER_TEXT "Trex CLI (opcional)" "Conecta modelos mediante tus propias API keys."
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
  ${NSD_CreateLabel} 0 42u 100% 50u "Permite crear perfiles TREX1, TREX2 y conectar proveedores API. Las API keys y el uso de cada proveedor se configuran después en Trex.$\r$\n$\r$\nSin esta opción puedes seguir usando Claude Code y Codex."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function TrexCliPageLeave
  ${NSD_GetState} $TrexCliCheckbox $TrexCliSelected
FunctionEnd

Function TrexCliSelectionChanged
  Pop $0
  ${NSD_GetState} $TrexCliCheckbox $TrexCliSelected
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  Call TrexCliInitialize
!macroend

!macro NSIS_HOOK_POSTINSTALL
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
!macroend

!macro NSIS_HOOK_PREUNINSTALL
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
!macroend
!endif
