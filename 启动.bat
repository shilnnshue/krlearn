@echo off
chcp 936 >nul 2>nul
setlocal
rem 清掉可能从外部继承的 Python 编码设置。
rem 有它们时 Python 会绕过 Windows 控制台的宽字符通道、直接吐 UTF-8 字节，
rem 在 936 代码页下中文全变乱码。
set "PYTHONUTF8="
set "PYTHONIOENCODING="
title 韩语识别型学习 krlearn
cd /d "%~dp0"
cls
echo.
echo  ==========================================
echo    韩语识别型学习  krlearn
echo  ==========================================
echo.

if not exist "serve.py" (
    echo  [X] 启动.bat 必须和 serve.py 放在同一目录
    echo      当前目录: %CD%
    echo.
    pause
    exit /b 1
)

set "PY="

if exist "C:\Users\27028\.workbuddy\binaries\python\versions\3.13.12\python.exe" set "PY=C:\Users\27028\.workbuddy\binaries\python\versions\3.13.12\python.exe"
if not defined PY if exist "C:\Users\27028\.workbuddy\binaries\python\envs\default\Scripts\python.exe" set "PY=C:\Users\27028\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
if defined PY goto gotpy

rem PATH 里的 python，跳过微软商店的假存根（那个运行只会弹商店）
for /f "delims=" %%i in ('where python 2^>nul') do (
    if not defined PY (
        echo %%i | find /i "WindowsApps" >nul
        if errorlevel 1 set "PY=%%i"
    )
)
if defined PY goto gotpy

for /f "delims=" %%i in ('where py 2^>nul') do (
    if not defined PY (
        echo %%i | find /i "WindowsApps" >nul
        if errorlevel 1 set "PY=%%i"
    )
)
if defined PY goto gotpy

echo  [X] 没有找到 Python 3
echo.
echo      请安装 Python 3.10 或更新版本，安装时勾选 Add to PATH
echo      下载: https://www.python.org/downloads/
echo.
pause
exit /b 1

:gotpy
echo  Python: %PY%
echo.
echo  正在启动本地服务，稍后浏览器会自动打开...
echo.
"%PY%" serve.py
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
    echo.
    echo  程序异常退出，代码 %RC%
    echo  把上面的报错整段发给我即可定位
    echo.
    pause
)
exit /b %RC%
