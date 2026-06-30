@echo off
setlocal enabledelayedexpansion
rem ============================================================
rem  CLG Search - one-click launcher (run setup.bat once first)
rem  Brings up Docker (Postgres+Redis) then API + Web + Crawler.
rem ============================================================
cd /d "%~dp0"
echo ============================================================
echo   Starting CLG Search...
echo ============================================================

rem --- .env safety: create from example if missing ---
if not exist ".env" (
  if exist ".env.example" (
    copy /y ".env.example" ".env" >nul
    echo Created .env from .env.example
  )
)

rem --- Docker installed? ---
where docker >nul 2>nul
if errorlevel 1 (
  echo [X] Docker not found. Install Docker Desktop, then re-run start.bat.
  pause & exit /b 1
)

rem --- Docker engine running? start Docker Desktop if not ---
docker info >nul 2>nul
if errorlevel 1 (
  echo Docker engine not running - starting Docker Desktop...
  if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" (
    start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
  ) else (
    echo [X] Docker Desktop not found. Start it manually, then re-run.
    pause & exit /b 1
  )
)
echo Waiting for the Docker engine...
:waitdocker
docker info >nul 2>nul
if errorlevel 1 ( timeout /t 4 /nobreak >nul & goto waitdocker )
echo Docker engine ready.

rem --- Infrastructure ONLY (apps run on the host below, not in Docker) ---
echo Starting database + redis...
docker compose up -d postgres redis
if errorlevel 1 (
  echo [X] Could not start Postgres/Redis. See the message above.
  pause & exit /b 1
)

rem --- Wait for Postgres to accept connections ---
echo Waiting for the database...
set /a tries=0
:waitdb
docker exec clg-postgres pg_isready -U postgres >nul 2>nul
if not errorlevel 1 goto dbready
set /a tries+=1
if !tries! geq 30 ( echo [!] Database slow to start - continuing anyway. & goto dbready )
timeout /t 2 /nobreak >nul
goto waitdb
:dbready
echo Database ready.

rem --- Free our app ports if a previous run left them open (fixes EADDRINUSE) ---
echo Freeing ports 4100 and 3100 if still in use from a previous run...
for %%P in (4100 3100) do (
  for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%P " ^| findstr LISTENING') do (
    echo   port %%P was held by PID %%a - stopping it
    taskkill /f /pid %%a >nul 2>nul
  )
)

rem --- Stop any orphaned crawl engine from a previous run (via its lock file) ---
if exist "%~dp0storage\crawler.lock" (
  for /f "tokens=2 delims=:," %%a in ('findstr "pid" "%~dp0storage\crawler.lock"') do taskkill /f /pid %%a /t >nul 2>nul
  del /q "%~dp0storage\crawler.lock" >nul 2>nul
)

rem --- Launch API + Web (the API auto-starts the single crawl engine itself) ---
echo Launching API and Web...
start "CLG Search - API" cmd /k "%~dp0scripts\run-api.bat"
start "CLG Search - Web" cmd /k "%~dp0scripts\run-web.bat"

echo Waiting for the dashboard to compile...
timeout /t 14 /nobreak >nul
start "" http://localhost:3100

echo.
echo   Dashboard : http://localhost:3100
echo   API       : http://localhost:4100
echo   The crawl ENGINE is started automatically by the API and is
echo   controlled from the dashboard Crawl page (Start / Stop / Restart).
echo   Two windows opened (API / Web) - close them to stop everything.
echo.
pause
