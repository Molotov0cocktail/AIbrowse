; AIbrowse owns this NSIS control flow and excludes the default recursive
; installation and removal sections.
Unicode true
Var appExe
Var finalInstallRoot

!include "common.nsh"
!include "MUI2.nsh"
!include "multiUser.nsh"
!include "nsProcess.nsh"
!include "${PROJECT_DIR}\release\installer-generated\installer-binding.nsh"

RequestExecutionLevel user

!macro AIBROWSE_REJECT_DELETE_APP_DATA
  ${GetParameters} $R0
  ${GetOptions} $R0 "--delete-app-data" $R1
  ${IfNot} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "AIbrowse 卸载始终保留本地数据；不支持 --delete-app-data。"
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro AIBROWSE_EXTRACT_HELPER
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=installer-helper.exe "${PROJECT_DIR}\${AIBROWSE_INSTALLER_HELPER}"
  File /oname=installer-owned-v1.json "${PROJECT_DIR}\${AIBROWSE_OWNED_MANIFEST}"
!macroend

!macro AIBROWSE_REQUIRE_STOPPED
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${If} $R0 != 603
    MessageBox MB_OK|MB_ICONEXCLAMATION "AIbrowse 尚在运行，或无法确认退出。请正常关闭后重试；本次未修改程序和数据。"
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${nsProcess::FindProcess} "guardian.exe" $R0
  ${If} $R0 != 603
    MessageBox MB_OK|MB_ICONEXCLAMATION "AIbrowse 数据进程尚未退出，或无法确认退出。请等待关闭完成后重试。"
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro AIBROWSE_HELPER ACTION
  ClearErrors
  ExecWait '"$PLUGINSDIR\installer-helper.exe" "${ACTION}" "$finalInstallRoot"' $R0
  ${If} ${Errors}
  ${OrIf} $R0 != 0
    SetErrorLevel 2
    Abort "AIbrowse 安装事务 ${ACTION} 失败；原程序和本地数据已保留。"
  ${EndIf}
!macroend

!ifdef BUILD_UNINSTALLER
  SilentInstall silent

  Function .onInit
    WriteUninstaller "${UNINSTALLER_OUT_FILE}"
    !insertmacro quitSuccess
  FunctionEnd

  Function un.onInit
    StrCpy $finalInstallRoot "$INSTDIR"
    !insertmacro AIBROWSE_REJECT_DELETE_APP_DATA
    !insertmacro AIBROWSE_REQUIRE_STOPPED
    !insertmacro AIBROWSE_EXTRACT_HELPER
  FunctionEnd

  Section "uninstall"
    ExecWait '"$PLUGINSDIR\installer-helper.exe" "uninstall" "$INSTDIR"' $R0
    ${If} ${Errors}
    ${OrIf} $R0 != 0
      MessageBox MB_OK|MB_ICONSTOP "安装目录包含未知文件、链接或损坏内容。为避免误删，本次卸载已停止。"
      SetErrorLevel 2
      Quit
    ${EndIf}
    WinShell::UninstAppUserModelId "${APP_ID}"
    Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
    Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
    DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
    DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"
    Delete "$INSTDIR\${UNINSTALL_FILENAME}"
    RMDir "$INSTDIR"
  SectionEnd
!else
  !include "assistedInstaller.nsh"
  !insertmacro addLangs
  !insertmacro MUI_PAGE_DIRECTORY
  !insertmacro MUI_PAGE_INSTFILES
  !insertmacro MUI_LANGUAGE "SimpChinese"

  Function .onInit
    !insertmacro check64BitAndSetRegView
    !insertmacro initMultiUser
    !insertmacro setInstallModePerUser
    !insertmacro AIBROWSE_REQUIRE_STOPPED
    !insertmacro AIBROWSE_EXTRACT_HELPER
  FunctionEnd

  Function .onInstFailed
    ${If} $finalInstallRoot != ""
      ExecWait '"$PLUGINSDIR\installer-helper.exe" "rollback" "$finalInstallRoot"' $R0
    ${EndIf}
  FunctionEnd

  Section "install" INSTALL_SECTION_ID
    !insertmacro AIBROWSE_REQUIRE_STOPPED
    StrCpy $finalInstallRoot "$INSTDIR"
    !insertmacro AIBROWSE_HELPER "recover"

    StrCpy $INSTDIR "$finalInstallRoot.aibrowse-new"
    CreateDirectory "$INSTDIR"
    SetOutPath "$INSTDIR"
    File /r "${PROJECT_DIR}\release\win-unpacked\*.*"
    File /oname=${UNINSTALL_FILENAME} "${UNINSTALLER_OUT_FILE}"
    StrCpy $INSTDIR "$finalInstallRoot"

    !insertmacro AIBROWSE_HELPER "inspect-new"
    !insertmacro AIBROWSE_HELPER "commit"

    StrCpy $appExe "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
    WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" KeepShortcuts "true"
    WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" ShortcutName "${SHORTCUT_NAME}"
    WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayName "${UNINSTALL_DISPLAY_NAME}"
    WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayVersion "${VERSION}"
    WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayIcon "$appExe,0"
    WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString '"$INSTDIR\${UNINSTALL_FILENAME}" /currentuser'
    WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString '"$INSTDIR\${UNINSTALL_FILENAME}" /currentuser /S'
    WriteRegDWORD HKCU "${UNINSTALL_REGISTRY_KEY}" NoModify 1
    WriteRegDWORD HKCU "${UNINSTALL_REGISTRY_KEY}" NoRepair 1
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$appExe"
    CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "$appExe"

    !insertmacro AIBROWSE_HELPER "finalize"
  SectionEnd
!endif
