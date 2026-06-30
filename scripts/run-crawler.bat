@echo off
rem Optional resilient crawler launcher (self-healing loop). The dashboard can also
rem Start/Stop/Restart the engine from the Crawl page. Portable paths via %~dp0.
cd /d "%~dp0.."
set NODE_OPTIONS=--max-old-space-size=3072
:loop
corepack pnpm@9.12.0 --filter "@clg/crawler" start
echo [run-crawler] worker exited, restarting in 5s...
timeout /t 5 /nobreak >nul
goto loop
