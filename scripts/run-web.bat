@echo off
rem Start the web dashboard. Portable: resolves the repo root from this script's path.
cd /d "%~dp0.."

rem --- Read the reconciled ports (regenerate if missing) so the dashboard
rem     always points at the SAME API port setup/start chose. ---
if not exist "%~dp0ports.bat" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0preflight.ps1" "%~dp0.." >nul 2>nul
)
if exist "%~dp0ports.bat" ( call "%~dp0ports.bat" ) else (
  set "API_PORT=4100" & set "WEB_PORT=3100"
)
set "NEXT_PUBLIC_API_URL=http://localhost:%API_PORT%"

rem --- OneDrive turns the .next build cache into cloud placeholder files. Next's
rem     startup cleanup then crashes with "EINVAL: readlink ... app-paths-manifest.json".
rem     Remove the stale cache so Next rebuilds it fresh (a dev compile is fast). ---
if exist ".next" rmdir /s /q ".next" >nul 2>nul
if exist "apps\web\.next" rmdir /s /q "apps\web\.next" >nul 2>nul

corepack pnpm@9.12.0 --filter "@clg/web" exec next dev -p %WEB_PORT%
