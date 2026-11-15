@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal

rem 优先用 DSH 自带的 node（用户机器上不一定装了 Node，也不一定在 PATH）
set "NODE="
set "DSH_NODE_A=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
set "DSH_NODE_B=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if exist "%DSH_NODE_A%" set "NODE=%DSH_NODE_A%"
if not defined NODE if exist "%DSH_NODE_B%" set "NODE=%DSH_NODE_B%"
if defined NODE goto run

where node >nul 2>nul
if not errorlevel 1 set "NODE=node"
if defined NODE goto run

echo.
echo [X] 没有找到 Node.js 22+，也没有找到 DeepSeek Harness 自带的 node。
echo     请先安装 Node.js 22+，或从 DSH 安装目录运行本脚本。
echo.
pause
exit /b 1

:run
"%NODE%" install-jianmu.mjs %*
echo.
pause
endlocal
