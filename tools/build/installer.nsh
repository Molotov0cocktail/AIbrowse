!macro customInstallMode
  ; Keep assisted installation in the current user's scope.
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customCheckAppRunning
  ; Never kill an application or a writer to make an upgrade proceed.
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${If} $R0 != 603
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "AIbrowse 尚在运行，或无法确认退出。请先正常关闭应用，再重新运行安装或卸载；本次未修改程序和本地数据。"
    ${EndIf}
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${nsProcess::FindProcess} "guardian.exe" $R0
  ${If} $R0 != 603
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "数据进程尚未退出，或无法确认退出。请等待正常关闭完成，再重新运行安装或卸载；本次未修改程序和本地数据。"
    ${EndIf}
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customUnInit
  ; The normal uninstaller preserves userData. Make that behavior visible.
  ${IfNot} ${Silent}
    MessageBox MB_OK|MB_ICONINFORMATION "卸载仅移除 AIbrowse 程序；本地信源、研究、监控、保存的对话、凭据和浏览器会话将保留。重新安装后可继续使用。"
  ${EndIf}
!macroend
