@echo off
REM =====================================================
REM 震坤行API - 2. 启动后台服务（端口默认 8000）
REM 输出日志到 server.log，同时写入 PID 到 server.pid 方便停止
REM =====================================================
chcp 65001 >nul
cd /d "%~dp0"
set PORT=8000
set NODE_ENV=development

echo [STEP 2/3] 启动 ZKH API 服务  port=%PORT%  cwd=%cd%
echo [INFO] 服务启动后会最小化到后台，不要关闭此新窗口！
echo [INFO] 日志文件: %cd%\server.log
echo [INFO] 停止服务请运行:  stop-server.cmd
echo.

if not exist node_modules (
  echo [ERROR] 未找到 node_modules，请先运行 1-install.cmd
  pause
  exit /b 2
)

REM 用 start /b 后台运行 + 输出日志，这样停掉 CMD 窗口不影响服务
start "ZKH API Server (port %PORT% - 不要关闭！）" cmd /c "node server.js >> server.log 2>&1"

REM 写入 start 时间便于追踪
echo started_at=%date% %time% > server.started
echo started_at=%date% %time%

REM 轮询等待健康检查通过
echo [WAIT] 等待服务启动中，最多 40 秒...
setlocal enabledelayedexpansion
set /a n=0
:WAIT_LOOP
set /a n+=1
if !n! GEQ 40 goto WAIT_TIMEOUT
timeout /t 1 /nobreak >nul
curl -s -m 2 http://localhost:%PORT%/health >nul 2>&1
if %errorlevel%==0 goto WAIT_OK
goto WAIT_LOOP

:WAIT_OK
echo.
echo [READY] ✓ 服务就绪 http://localhost:%PORT%/
echo         API 说明: http://localhost:%PORT%/
echo         健康检查: http://localhost:%PORT%/health
echo         代理状态: http://localhost:%PORT%/api/proxy/status
echo.
echo         接下来可以双击运行  3-run-test-report.cmd
echo.
goto END

:WAIT_TIMEOUT
echo.
echo [WARN] 40秒内健康检查未通过，可能是 npm install 未完成或后台初始化慢。
echo        请手动打开: http://localhost:%PORT%/health  检查是否返回 status: ok
echo        若返回正常则可继续运行测试；否则查看 server.log 排查问题。
echo.

:END
start "" http://localhost:%PORT%/
pause
