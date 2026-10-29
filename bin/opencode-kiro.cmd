@echo off
setlocal
if defined KIRO_GATEWAY_NODE (
  "%KIRO_GATEWAY_NODE%" "%~dp0..\src\opencode-kiro.mjs" %*
) else if exist "%LOCALAPPDATA%\Kiro-Cli\node.exe" (
  "%LOCALAPPDATA%\Kiro-Cli\node.exe" "%~dp0..\src\opencode-kiro.mjs" %*
) else (
  node "%~dp0..\src\opencode-kiro.mjs" %*
)
