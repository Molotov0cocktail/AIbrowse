Unicode true
RequestExecutionLevel admin
!include "MUI2.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
Name "${APP_NAME}"
Icon "${APP_ICON}"
!define MUI_ICON "${APP_ICON}"
OutFile "${OUTPUT_EXE}"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"
Function .onInit
  ${IfNot} ${RunningX64}
    Abort "仅支持64位Windows。"
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    Abort "需要Windows 10或更新系统。"
  ${EndIf}
  SetShellVarContext all
FunctionEnd
Section "安装"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=AIbrowse.msi "${INPUT_MSI}"
  ; MSI owns every product file operation, registration, removal and rollback.
  ${DisableX64FSRedirection}
  StrCpy $0 1603
  ClearErrors
  ExecWait '"$SYSDIR\msiexec.exe" /i "$PLUGINSDIR\AIbrowse.msi" /qn /norestart ALLUSERS=1 MSIINSTALLPERUSER="" REBOOT=ReallySuppress MSIRESTARTMANAGERCONTROL=Disable MSIDISABLERMRESTART=1' $0
  ${If} ${Errors}
    ${EnableX64FSRedirection}
    SetErrorLevel 1603
    Abort "无法启动Windows安装服务，安装未执行。"
  ${EndIf}
  ${EnableX64FSRedirection}
  ${If} $0 != 0
    SetErrorLevel $0
    Abort "安装未完成。请查看系统安装错误，保留原程序与本地数据。"
  ${EndIf}
  DetailPrint "安装完成。卸载只移除已注册的程序组件，本地数据与凭据始终保留。"
SectionEnd
