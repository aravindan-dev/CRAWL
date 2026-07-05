@echo off
setlocal enabledelayedexpansion
rem ============================================================
rem  CLG Search - first-time setup (run once on a new PC)
rem
rem  Works on a clean machine: checks/installs Node + Docker,
rem  installs ALL dependencies (incl. Prisma), reconciles ports
rem  so the API port matches everywhere, brings up Postgres +
rem  Redis, and creates the database schema.
rem ============================================================
cd /d "%~dp0"
echo ============================================================
echo   CLG Search - first-time setup
echo ============================================================

rem --- [1/9] Node present? (offer winget install if missing) ---
echo [1/9] Checking Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js not found. Attempting install via winget...
  where winget >nul 2>nul
  if not errorlevel 1 (
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    rem winget updates the REGISTRY PATH, not this already-running shell -
    rem add the standard install dir so the rest of setup sees node NOW.
    if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
  )
  where node >nul 2>nul
  if errorlevel 1 (
    echo [X] Node.js 20+ is required. Install it from https://nodejs.org then re-run setup.bat.
    pause & exit /b 1
  )
)
for /f "delims=" %%v in ('node -v') do echo   Node %%v

rem --- [2/9] Enable pnpm via corepack ---
echo [2/9] Enabling pnpm (corepack)...
call corepack enable >nul 2>nul

rem --- [3/9] Env + port reconciliation (creates .env, syncs API port) ---
echo [3/9] Preparing .env and reconciling ports...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\preflight.ps1" "%~dp0"
if errorlevel 1 ( echo [X] Environment preflight failed. See above. & pause & exit /b 1 )
if exist "%~dp0scripts\ports.bat" call "%~dp0scripts\ports.bat"

rem --- [4/9] Install all dependencies (Prisma, Playwright, etc.) ---
echo [4/9] Installing dependencies (this can take a few minutes)...
call corepack pnpm@9.12.0 install
if errorlevel 1 ( echo [X] Dependency install failed. See above. & pause & exit /b 1 )

rem --- [5/9] Playwright browser binaries (the crawler cannot run without them) ---
echo [5/9] Installing the Playwright Chromium browser (first run only)...
call corepack pnpm@9.12.0 --filter @clg/crawler exec playwright install chromium
if errorlevel 1 ( echo   [!] Playwright browser install reported an issue - the crawler needs it. Re-run setup.bat if crawling fails to start. )

rem --- [6/9] Docker installed + running (offer winget install if missing) ---
echo [6/9] Checking Docker...
where docker >nul 2>nul
if errorlevel 1 (
  echo   Docker not found. Attempting install via winget...
  where winget >nul 2>nul
  if not errorlevel 1 (
    winget install -e --id Docker.DockerDesktop --accept-source-agreements --accept-package-agreements
    rem Same PATH caveat as Node: make the fresh install visible to THIS shell.
    if exist "%ProgramFiles%\Docker\Docker\resources\bin" set "PATH=%ProgramFiles%\Docker\Docker\resources\bin;%PATH%"
    echo   Docker Desktop installed. If this is its very first launch, Windows
    echo   may ask to enable WSL2 and to sign out/in once - do that, start
    echo   Docker Desktop, then re-run setup.bat.
  )
  where docker >nul 2>nul
  if errorlevel 1 (
    echo [X] Docker Desktop is required for Postgres + Redis.
    echo     Install it from https://www.docker.com/products/docker-desktop then re-run setup.bat.
    pause & exit /b 1
  )
)
docker info >nul 2>nul
if errorlevel 1 (
  echo   Docker engine not running - starting Docker Desktop...
  if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
)
echo   Waiting for the Docker engine...
set /a dtries=0
:waitdocker
docker info >nul 2>nul
if not errorlevel 1 goto dockerready
set /a dtries+=1
if !dtries! geq 60 ( echo [X] Docker engine did not come up. Start Docker Desktop and re-run. & pause & exit /b 1 )
timeout /t 4 /nobreak >nul
goto waitdocker
:dockerready
echo   Docker engine ready.

rem --- [7/9] Start Postgres + Redis on the reconciled host ports ---
echo [7/9] Starting database + redis (postgres:!POSTGRES_HOST_PORT! redis:!REDIS_HOST_PORT!)...
docker compose up -d postgres redis
if errorlevel 1 ( echo [X] Could not start Postgres/Redis. & pause & exit /b 1 )

rem --- [8/9] Wait for BOTH Postgres and Redis to be ready ---
echo [8/9] Waiting for Postgres...
set /a tries=0
:waitdb
docker exec clg-postgres pg_isready -U postgres >nul 2>nul
if not errorlevel 1 goto dbready
set /a tries+=1
if !tries! geq 30 ( echo   [!] Postgres slow to start - continuing anyway. & goto dbready )
timeout /t 2 /nobreak >nul
goto waitdb
:dbready
echo   Postgres ready.

echo        Waiting for Redis...
set /a rtries=0
:waitredis
docker exec clg-redis redis-cli ping 2>nul | findstr /i "PONG" >nul 2>nul
if not errorlevel 1 goto redisready
set /a rtries+=1
if !rtries! geq 30 ( echo   [!] Redis slow to start - continuing anyway. & goto redisready )
timeout /t 2 /nobreak >nul
goto waitredis
:redisready
echo   Redis ready.

rem --- [9/9] Prisma client + database schema + seed + verify ---
echo [9/9] Generating Prisma client + creating schema...
call corepack pnpm@9.12.0 run db:generate
if errorlevel 1 ( echo [X] Prisma client generation failed. See above. & pause & exit /b 1 )
call corepack pnpm@9.12.0 run db:migrate:deploy
if errorlevel 1 ( echo   [!] Schema step reported an issue - check the output above. )
echo        Seeding defaults (safe to re-run)...
call corepack pnpm@9.12.0 run db:seed
if errorlevel 1 ( echo   [!] Seed reported an issue - check the output above. )
echo        Verifying the database end-to-end...
docker exec clg-postgres psql -U postgres -d clgsearch -t -c "select 'DB_OK';" 2>nul | findstr /i "DB_OK" >nul 2>nul
if errorlevel 1 ( echo   [!] Could not verify the database - if start.bat fails, re-run setup.bat. ) else ( echo   Database verified. )

echo.
echo ============================================================
echo   Setup complete.
echo     Dashboard : http://localhost:!WEB_PORT!
echo     API       : http://localhost:!API_PORT!
echo   Now run start.bat to launch CLG Search.
echo ============================================================
echo.
pause
