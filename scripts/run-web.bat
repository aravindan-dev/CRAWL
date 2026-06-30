@echo off
rem Start the web dashboard. Portable: resolves the repo root from this script's path.
cd /d "%~dp0.."
set NEXT_PUBLIC_API_URL=http://localhost:4100

rem --- OneDrive turns the .next build cache into cloud placeholder files. Next's
rem     startup cleanup then crashes with "EINVAL: readlink ... app-paths-manifest.json".
rem     Remove the stale cache so Next rebuilds it fresh (a dev compile is fast). ---
if exist ".next" rmdir /s /q ".next" >nul 2>nul
if exist "apps\web\.next" rmdir /s /q "apps\web\.next" >nul 2>nul

corepack pnpm@9.12.0 --filter "@clg/web" exec next dev -p 3100
