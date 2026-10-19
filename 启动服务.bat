@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   吸血鬼辛存者 - 局域网服务启动
echo ============================================
echo.

rem 开一个「优雅停机」出口：之后在本机执行 停服务.bat 或
rem POST http://127.0.0.1:3000/api/shutdown 就能干净地停掉服务。
rem 这不是为了好看 —— 本地 pglite 是单写入者，强杀进程会留锁甚至写坏 WAL。
rem 线上（云托管）不会设这个变量，该接口等于不存在。
set DEV_SHUTDOWN=1

rem ★兜底顺序：环境变量 VS_NODE > 标准安装路径。
rem   原来这里写死了某个盘上的 node 路径 —— 那种兜底只对写它的那台机器有用，
rem   换台机器反而误导（提示了一个不存在的路径）。所以改成通用写法。
where node >nul 2>nul
if errorlevel 1 (
  if defined VS_NODE if exist "%VS_NODE%" (
    echo [info] PATH 里没找到 node，改用环境变量 VS_NODE = %VS_NODE%
    "%VS_NODE%" server\index.js
    goto end
  )
  if exist "%ProgramFiles%\nodejs\node.exe" (
    echo [info] PATH 里没找到 node，改用 %ProgramFiles%\nodejs\node.exe
    "%ProgramFiles%\nodejs\node.exe" server\index.js
    goto end
  )
  echo [error] 没有找到 node，请先安装 Node.js 或把 node 加进 PATH
  echo         若 Node 装在非标准位置，可设置环境变量 VS_NODE 指向 node.exe
  goto end
)

node server\index.js

:end
echo.
echo 服务已停止
pause
