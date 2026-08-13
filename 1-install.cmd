@echo off
REM =====================================================
REM 震坤行API - 1. 安装依赖
REM 绕过 PowerShell 执行策略，直接用 CMD 跑 npm
REM =====================================================
chcp 65001 >nul
cd /d "%~dp0"
echo [STEP 1/3] 进入目录: %cd%
echo [STEP 1/3] 开始安装 npm 依赖（生产包 + 开发包）...
echo.
call npm install
if errorlevel 1 (
  echo.
  echo [ERROR] npm install 失败，请检查 Node.js 版本（需要 >= 18）
  echo        查看版本: node --version
  pause
  exit /b 1
)
echo.
echo [DONE] npm install 完成！
echo        接下来可以双击运行  start-server.cmd
pause
