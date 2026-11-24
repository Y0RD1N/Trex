!ifndef TREX_CLI_INCLUDED
!define TREX_CLI_INCLUDED
!include LogicLib.nsh
!include nsDialogs.nsh
!include FileFunc.nsh
!include "Win\COM.nsh"

; A non-secret preference outside Tauri's app-data/removal registry subtree.
; The override is used only by the isolated installer verification script.
!ifndef TREX_CLI_REGISTRY_KEY
  !define TREX_CLI_REGISTRY_KEY "Software\com.trex.app\Installer"
!endif

; ---- Trex Browser retirado ---------------------------------------------------
; Versiones anteriores podían dejar junto a trex el navegador Trex Browser:
; trex-browser.exe, trex-browser-runtime\, sus .payload y .previous, accesos
; directos y la preferencia InstallBrowser. Se quitan al instalar, actualizar y
; desinstalar. Antes se paran sus procesos, solo los que se ejecutan desde esas
; rutas. Lo que siga bloqueado se deja con un aviso en el detalle: nunca aborta.
; Los perfiles y datos privados viven fuera de $INSTDIR: los borra la app si la
; persona lo pide.

Var TrexLegacyLinks

!macro TrexLegacyBrowserDeleteIn PREFIX NAME
  Push "$INSTDIR\${NAME}"
  Call ${PREFIX}TrexLegacyBrowserDelete
!macroend

!macro TrexLegacyBrowserFunctions PREFIX
; Para los procesos cuyo ejecutable está dentro de <carpeta>\trex-browser-runtime\
; o es <carpeta>\trex-browser.exe. Entrada: la carpeta, en la pila.
Function ${PREFIX}TrexLegacyBrowserStop
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  Push $0
  Push $1
  ; La ruta de un proceso llega en su forma larga: la carpeta también.
  System::Call 'kernel32::GetLongPathNameW(w R0, w .r1, i ${NSIS_MAX_STRLEN}) i .r0'
  ${If} $0 > 0
  ${AndIf} $0 < ${NSIS_MAX_STRLEN}
    StrCpy $R0 $1
  ${EndIf}
  StrCpy $R1 "$R0\trex-browser-runtime\"
  StrLen $R2 $R1
  StrCpy $R3 "$R0\trex-browser.exe"
  System::Alloc 65536
  Pop $R4
  ${If} $R4 P<> 0
    System::Call 'kernel32::K32EnumProcesses(p R4, i 65536, *i .R5) i .R6'
    ${If} $R6 <> 0
      IntOp $R5 $R5 / 4
      StrCpy $R6 0
      ${DoWhile} $R6 < $R5
        IntOp $R7 $R6 * 4
        IntPtrOp $R7 $R4 + $R7
        System::Call '*$R7(i .R7)'
        ; PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE
        System::Call 'kernel32::OpenProcess(i 0x101001, i 0, i R7) p .R8'
        ${If} $R8 P<> 0
          ; La ruta se lee con el mismo manejador que lo para: un PID reutilizado no cuenta.
          System::Call 'kernel32::QueryFullProcessImageNameW(p R8, i 0, w .R9, *i ${NSIS_MAX_STRLEN}) i .r0'
          ${If} $0 <> 0
            StrCpy $1 $R9 $R2
            ${If} $1 == $R1
            ${OrIf} $R9 == $R3
              DetailPrint "Parando un proceso del Trex Browser antiguo: $R9"
              System::Call 'kernel32::TerminateProcess(p R8, i 1)'
              System::Call 'kernel32::WaitForSingleObject(p R8, i 5000)'
            ${EndIf}
          ${EndIf}
          System::Call 'kernel32::CloseHandle(p R8)'
        ${EndIf}
        IntOp $R6 $R6 + 1
      ${Loop}
    ${EndIf}
    System::Free $R4
  ${EndIf}
  Pop $1
  Pop $0
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

; Marca TrexLegacyLinks si hay un enlace o junction en el árbol (sin entrar en él).
Function ${PREFIX}TrexLegacyBrowserFindLinks
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  FindFirst $1 $2 "$0\*"
  ${DoWhile} $2 != ""
    ${If} $2 != "."
    ${AndIf} $2 != ".."
      ; Sin atributos legibles (-1) cuenta como enlace: se prefiere no borrar.
      System::Call 'kernel32::GetFileAttributesW(w "$0\$2") i .r3'
      IntOp $4 $3 & 0x400
      ${If} $4 <> 0
        StrCpy $TrexLegacyLinks 1
      ${Else}
        IntOp $4 $3 & 0x10
        ${If} $4 <> 0
          Push "$0\$2"
          Call ${PREFIX}TrexLegacyBrowserFindLinks
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ${If} $TrexLegacyLinks == 1
      ${ExitDo}
    ${EndIf}
    FindNext $1 $2
  ${Loop}
  FindClose $1
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Borra un archivo o una carpeta sin seguir enlaces. Entrada: la ruta, en la pila.
Function ${PREFIX}TrexLegacyBrowserDelete
  Exch $0
  Push $1
  Push $2
  StrCpy $TrexLegacyLinks 0
  System::Call 'kernel32::GetFileAttributesW(w r0) i .r1'
  ${If} $1 <> -1
    IntOp $2 $1 & 0x400
    ${If} $2 <> 0
      DetailPrint "Aviso: $0 es un enlace; no se toca."
    ${Else}
      IntOp $2 $1 & 0x10
      ${If} $2 <> 0
        Push $0
        Call ${PREFIX}TrexLegacyBrowserFindLinks
        ${If} $TrexLegacyLinks == 1
          DetailPrint "Aviso: $0 contiene enlaces; no se borra."
        ${Else}
          RMDir /r "$0"
        ${EndIf}
      ${Else}
        Delete "$0"
      ${EndIf}
      System::Call 'kernel32::GetFileAttributesW(w r0) i .r1'
      ${If} $1 <> -1
      ${AndIf} $TrexLegacyLinks == 0
        DetailPrint "Aviso: no se pudo borrar $0 (en uso). Se puede borrar a mano."
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ClearErrors
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Borra un acceso directo de Trex Browser solo si apunta dentro de $INSTDIR:
; el de una instalación independiente se queda. Entrada: el .lnk, en la pila.
Function ${PREFIX}TrexLegacyBrowserShortcut
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  ${If} ${FileExists} "$0"
    !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} r1 ""
    ${If} $1 P<> 0
      ${IUnknown::QueryInterface} $1 '("${IID_IPersistFile}",.r2)'
      ${If} $2 P<> 0
        ${IPersistFile::Load} $2 '("$0",${STGM_READ}).r3'
        ${If} $3 = 0
          ${IShellLink::GetPath} $1 '(.r3,${NSIS_MAX_STRLEN},0,0).r4'
          StrLen $4 "$INSTDIR\"
          StrCpy $3 $3 $4
          ${If} $3 == "$INSTDIR\"
            Delete "$0"
          ${EndIf}
        ${EndIf}
        ${IUnknown::Release} $2 ""
      ${EndIf}
      ${IUnknown::Release} $1 ""
    ${EndIf}
  ${EndIf}
  ClearErrors
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function ${PREFIX}TrexLegacyBrowserCleanup
  ${If} ${FileExists} "$INSTDIR\trex-browser.exe"
  ${OrIf} ${FileExists} "$INSTDIR\trex-browser-runtime\*"
    Push $INSTDIR
    Call ${PREFIX}TrexLegacyBrowserStop
  ${EndIf}
  Push "$SMPROGRAMS\Trex Browser.lnk"
  Call ${PREFIX}TrexLegacyBrowserShortcut
  Push "$DESKTOP\Trex Browser.lnk"
  Call ${PREFIX}TrexLegacyBrowserShortcut
  !insertmacro TrexLegacyBrowserDeleteIn "${PREFIX}" "trex-browser.exe"
  !insertmacro TrexLegacyBrowserDeleteIn "${PREFIX}" "trex-browser-runtime"
  !insertmacro TrexLegacyBrowserDeleteIn "${PREFIX}" "trex-browser.payload"
  !insertmacro TrexLegacyBrowserDeleteIn "${PREFIX}" "trex-browser-runtime.payload"
  !insertmacro TrexLegacyBrowserDeleteIn "${PREFIX}" "trex-browser.exe.previous"
  !insertmacro TrexLegacyBrowserDeleteIn "${PREFIX}" "trex-browser-runtime.previous"
  DeleteRegValue HKCU "${TREX_CLI_REGISTRY_KEY}" "InstallBrowser"
  ClearErrors
FunctionEnd
!macroend
!insertmacro TrexLegacyBrowserFunctions ""
!insertmacro TrexLegacyBrowserFunctions "un."

; installer.nsi: el desinstalador de una versión anterior se niega a seguir si
; Trex Browser está en marcha. Sus procesos se paran antes de lanzarlo.
!macro TREX_BEFORE_PREVIOUS_UNINSTALL
  Push $0
  ReadRegStr $0 SHCTX "${MANUPRODUCTKEY}" ""
  ${If} $0 != ""
    Push $0
    Call TrexLegacyBrowserStop
  ${EndIf}
  Pop $0
  ClearErrors
!macroend

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
  !insertmacro MUI_HEADER_TEXT "Componentes opcionales de Trex" "Elige si instalar Trex CLI."
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
  Call TrexLegacyBrowserCleanup
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
  ; Keep the CLI choice through Tauri's uninstall/reinstall update flow.
  Call un.TrexLegacyBrowserCleanup
!macroend
!endif
