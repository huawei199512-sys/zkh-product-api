@echo off
REM =====================================================
REM 震坤行API - 停止后台服务
REM =====================================================
chcp 65001 >nul
cd /d "%~dp0"
echo [STOP] 尝试停止占用 8000 端口的 Node.js 进程...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8000 " ^| findstr LISTENING') do (
  echo [STOP] 找到 PID=%%a，执行 taskkill /F /PID %%a
  taskkill /F /PID %%a >nul 2>&1
)
REM 兜底：所有 node server.js 进程
wmic process where "commandline like '%%server.js%%'" get processid /format:list 2>nul | findstr "=" >nul 2>&1 && (
  for /f "tokens=2 delims==" %%i in ('wmic process where "commandline like '%%server.js%%'" get processid /format:list 2^>nul') do (
    echo [STOP] 兜底 PID=%%i，taskkill /F /PID %%i
    taskkill /F /PID %%i >nul 2>&1
  )
)
echo [DONE] 已尝试停止所有相关进程
pause
