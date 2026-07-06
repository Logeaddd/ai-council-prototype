!include LogicLib.nsh
!include nsDialogs.nsh

!ifndef BUILD_UNINSTALLER
Var AI_COUNCIL_DATA_DIR
Var AI_COUNCIL_DATA_DIR_TEXT
Var AI_COUNCIL_DATA_DIR_BROWSE
!endif

!macro customHeader
!macroend

!ifndef BUILD_UNINSTALLER
!macro customInit
  StrCpy $AI_COUNCIL_DATA_DIR "$LOCALAPPDATA\AI Council"
!macroend

!macro customPageAfterChangeDir
  Page custom DataDirPageCreate DataDirPageLeave
!macroend

Function DataDirPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 18u "数据保存位置"
  Pop $0
  ${NSD_CreateLabel} 0 20u 100% 22u "聊天记录、小组配置、成员私有记录和运行数据会保存在这里。"
  Pop $0
  ${NSD_CreateText} 0 52u 76% 13u "$AI_COUNCIL_DATA_DIR"
  Pop $AI_COUNCIL_DATA_DIR_TEXT
  ${NSD_CreateBrowseButton} 79% 51u 21% 15u "浏览..."
  Pop $AI_COUNCIL_DATA_DIR_BROWSE
  ${NSD_OnClick} $AI_COUNCIL_DATA_DIR_BROWSE DataDirBrowse

  nsDialogs::Show
FunctionEnd

Function DataDirBrowse
  ${NSD_GetText} $AI_COUNCIL_DATA_DIR_TEXT $AI_COUNCIL_DATA_DIR
  nsDialogs::SelectFolderDialog "选择数据保存位置" "$AI_COUNCIL_DATA_DIR"
  Pop $0
  ${If} $0 != error
    StrCpy $AI_COUNCIL_DATA_DIR "$0"
    ${NSD_SetText} $AI_COUNCIL_DATA_DIR_TEXT "$AI_COUNCIL_DATA_DIR"
  ${EndIf}
FunctionEnd

Function DataDirPageLeave
  ${NSD_GetText} $AI_COUNCIL_DATA_DIR_TEXT $AI_COUNCIL_DATA_DIR
  ${If} $AI_COUNCIL_DATA_DIR == ""
    MessageBox MB_ICONEXCLAMATION "请选择数据保存位置。"
    Abort
  ${EndIf}
FunctionEnd

!macro customInstall
  CreateDirectory "$AI_COUNCIL_DATA_DIR"
  FileOpen $0 "$INSTDIR\data-path.txt" w
  FileWrite $0 "$AI_COUNCIL_DATA_DIR"
  FileClose $0
!macroend
!endif
