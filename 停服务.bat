@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 优雅停掉本机服务（需先用 启动服务.bat 启动，因为它会开 DEV_SHUTDOWN=1）
rem 用法：停服务.bat [端口]     默认 3000

set PORT=%1
if "%PORT%"=="" set PORT=3000

echo.
echo 正在请求优雅停机： http://127.0.0.1:%PORT%/api/shutdown
echo.

curl -s -X POST "http://127.0.0.1:%PORT%/api/shutdown"
echo.

if errorlevel 1 (
  echo [warn] curl 请求失败或服务没在跑。
)

echo.
echo ------------------------------------------------------------
echo 如果上面没有返回 {"ok":true,...}，说明服务不是用 DEV_SHUTDOWN=1 启动的
echo （比如直接在别的窗口敲 node server/index.js）。
echo 那就回到服务所在窗口按 Ctrl+C 停掉。
echo.
echo 切勿强行结束进程（任务管理器 / taskkill /F）：
echo   本地数据库 pglite 是单写入者，硬杀会留下陈旧锁、甚至写坏 WAL，
echo   后果是下次启动直接报 [fatal] 数据层加载失败: Aborted()。
echo ------------------------------------------------------------
echo.
pause
