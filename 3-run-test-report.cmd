@echo off
REM =====================================================
REM 震坤行API - 3. 运行关键字搜索 + 随机5详情综合测试
REM 强制代理模式，输出 JSON + TXT 双格式测试报告
REM =====================================================
chcp 65001 >nul
cd /d "%~dp0"
setlocal enabledelayedexpansion

REM 允许传关键词参数（如 3-run-test-report.cmd 手套），默认 手套
set KEYWORD=%~1
if "%KEYWORD%"=="" set KEYWORD=手套

echo [STEP 3/3] 开始综合测试 - 关键词: %KEYWORD%
echo          强制代理模式 / 单代理10s切换 / 单请求30s截止
echo          预计总耗时: 1-8 分钟（视免费代理质量而定）
echo.

if not exist node_modules (
  echo [ERROR] 未找到 node_modules，请先运行 1-install.cmd
  pause
  exit /b 2
)

REM 先确认服务正在运行
curl -s -m 3 http://localhost:8000/health >nul 2>&1
if errorlevel 1 (
  echo [ERROR] 服务未启动！请先运行 2-start-server.cmd
  pause
  exit /b 3
)

echo [INFO] 服务健康检查通过 ✓
echo.

REM 执行测试脚本
call node test-report.js %KEYWORD%
set EXIT_CODE=%errorlevel%

echo.
echo ============================================================
echo  测试脚本执行完毕，退出码=%EXIT_CODE%
echo ============================================================
echo   EXIT_CODE=0 → 全部通过 ✓
echo   EXIT_CODE=1 → 部分失败
echo   EXIT_CODE=2 → 服务未就绪
echo.
echo  完整报告文件位于: %cd%\
dir /b test-report-*.txt test-report-*.json 2>nul | sort /r
echo ============================================================
pause
exit /b %EXIT_CODE%
