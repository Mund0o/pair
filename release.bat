@echo off
REM ===========================================================================
REM  Pair release script  -  builds + publishes a new version in one click.
REM
REM  What it does:
REM    1. Bumps the patch version in package.json (0.8.1 -> 0.8.2 ...)
REM    2. Builds the .exe (Windows) and .tar.gz (Linux) into dist8/
REM    3. Publishes them to public/ + writes public/latest.json
REM
REM  After this runs, anyone with the app open (or who restarts it) will be
REM  prompted to update within ~30 minutes. Make sure server.js is running and
REM  port 8787 is forwarded.
REM
REM  Requires: Node.js + the project's node_modules (npm install once).
REM ===========================================================================

setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo == Bumping patch version in package.json ==
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p='package.json'; $j=Get-Content $p -Raw | ConvertFrom-Json; $m=$j.version.Split('.'); $m[2]=[int]$m[2]+1; $j.version=$m -join '.'; $j | ConvertTo-Json -Depth 10 -Compress | Set-Content $p -NoNewline; Write-Host ('New version: ' + $j.version)"
for /f "tokens=*" %%V in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Content package.json -Raw | ConvertFrom-Json).version"') do set PKGVER=%%V
set PKGSAFE=%PKGVER:.=%
echo    (internal: PKGVER=%PKGVER%  PKGSAFE=%PKGSAFE%)

echo.
echo == Cleaning build work dir (admin) ==
powershell -NoProfile -Command "Remove-Item 'dist\win-unpacked' -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item 'dist\linux-unpacked' -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item 'dist\linux-unpacked.tmp' -Recurse -Force -ErrorAction SilentlyContinue; Write-Host 'cleared'" || echo (clean step skipped)

echo.
echo == Building + publishing (npm run dist) ==
set IS_PACKAGED=1
call npm run dist
if errorlevel 1 (
  echo.
  echo BUILD FAILED - see errors above. Version was already bumped; fix and re-run.
  pause
  exit /b 1
)

echo.
echo == Copying build output to dist8/ (for manual sharing) ==
if not exist dist8 mkdir dist8
for %%F in ("dist\Pair Setup %PKGVER%.exe" "dist\Pair Setup %PKGVER%.exe.blockmap" "dist\pair-p2p-%PKGVER%.tar.gz") do (
  if exist %%F copy /Y %%F dist8\ >nul && echo   copied %%~nxF
)

echo.
echo == Done. New release is live in public/ ==
echo    Feed: http://^<your-ip^>:8787/latest.json
echo    Make sure server.js is running (node server.js) and port 8787 is forwarded.
echo.
pause
