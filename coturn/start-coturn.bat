@echo off
REM ===========================================================================
REM  Pair TURN relay launcher.
REM
REM  Boots coturn via Docker (must have Docker Desktop running). coturn then
REM  stays up in the background and auto-restarts across reboots while Docker
REM  is running, so TURN is available for both peers whenever the app opens.
REM
REM  First-time setup:
REM    1. Forward these ports on your router to YOUR_LAN_IP (this PC):
REM         TCP 3481 → 3478,  UDP 3481 → 3478,  UDP 50100-50200
REM    2. Run this script ONCE. It keeps itself running afterwards.
REM
REM  Status:    docker ps --filter name=pair-coturn
REM  Logs:      docker logs -f pair-coturn
REM  Stop:      docker compose -f coturn\docker-compose.yml down
REM ===========================================================================

setlocal
cd /d "%~dp0"

where docker >nul 2>&1
if errorlevel 1 (
  echo Docker is not installed or not on PATH. Install Docker Desktop first.
  pause
  exit /b 1
)

docker info >nul 2>&1
if errorlevel 1 (
  echo Docker Desktop is not running. Start Docker Desktop, then re-run this script.
  pause
  exit /b 1
)

echo Starting coturn (Pair TURN relay)...
docker compose up -d
if errorlevel 1 (
  echo Failed to start coturn. See errors above.
  pause
  exit /b 1
)

echo.
echo coturn is running. Verify externally reachable TURN with:
echo   docker logs pair-coturn
echo.
echo Reminder: forward TCP 3481->3478, UDP 3481->3478, and UDP 50100-50200 to this PC.
timeout /t 5 >nul
endlocal
