@echo off
setlocal enabledelayedexpansion
rem ============================================================
rem  CLG Search - first-time setup (run once on a new PC)
rem  Requires: Node 20+ and Docker Desktop installed.
rem ============================================================
cd /d "%~dp0"
echo ============================================================
echo   CLG Search - first-time setup
echo ============================================================

rem --- Node present? ---
where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js not found. Install Node 20+ from nodejs.org, then re-run setup.bat.
  pause & exit /b 1
)

rem --- .env: create from example if missing ---
if not exist ".env" (
  if exist ".env.example" (
    copy /y ".env.example" ".env" >nul
    echo Created .env from .env.example
  )
)

echo [1/5] Enabling pnpm (corepack)...
call corepack enable >nul 2>nul

echo [2/5] Installing dependencies (this can take a few minutes)...
call corepack pnpm@9.12.0 install
if errorlevel 1 ( echo [X] Dependency install failed. See above. & pause & exit /b 1 )

rem --- Docker installed + running ---
where docker >nul 2>nul
if errorlevel 1 ( echo [X] Docker not found. Install Docker Desktop, then re-run. & pause & exit /b 1 )
docker info >nul 2>nul
if errorlevel 1 (
  echo Docker engine not running - starting Docker Desktop...
  if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
)
echo Waiting for the Docker engine...
:waitdocker
docker info >nul 2>nul
if errorlevel 1 ( timeout /t 4 /nobreak >nul & goto waitdocker )

echo [3/5] Starting database + redis...
docker compose up -d postgres redis
if errorlevel 1 ( echo [X] Could not start Postgres/Redis. & pause & exit /b 1 )

echo [4/5] Waiting for the database...
set /a tries=0
:waitdb
docker exec clg-postgres pg_isready -U postgres >nul 2>nul
if not errorlevel 1 goto dbready
set /a tries+=1
if !tries! geq 30 ( goto dbready )
timeout /t 2 /nobreak >nul
goto waitdb
:dbready

echo [5/5] Creating database schema...
call corepack pnpm@9.12.0 run db:generate
call corepack pnpm@9.12.0 run db:migrate:deploy
if errorlevel 1 ( echo [!] Schema step reported an issue - check the output above. )

echo.
echo   Setup complete. Now run start.bat to launch CLG Search.
echo.
pause
