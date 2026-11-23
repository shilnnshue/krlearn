@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"

set "PYTHONUTF8="
set "PYTHONIOENCODING="

echo ============================================
echo   Deploy to Cloudflare Pages (wrangler)
echo ============================================
echo.
echo  NOTE: this uploads the whole folder every time.
echo  If you can use GitHub, prefer the git way - see DEPLOY.md
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode

echo First run will open a browser to log in Cloudflare.
echo Then it uploads about 16000 files, may take 10-30 min.
echo.
pause

call npx --yes wrangler@latest pages deploy . --project-name=krlearn --branch=main --commit-dirty=true

if errorlevel 1 goto failed
echo.
echo  [OK] done. The address is the xxx.pages.dev printed above.
goto end

:nonode
echo  [ERROR] Node.js not found.
echo  Install it first: https://nodejs.org
echo  Then reopen this window.
goto end

:failed
echo.
echo  [FAILED] See the error above, send it to me.

:end
echo.
pause
