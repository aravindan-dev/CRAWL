@echo off
rem Optional resilient crawler launcher (self-healing loop). The dashboard can also
rem Start/Stop/Restart the engine from the Crawl page. Portable paths via %~dp0.
cd /d "%~dp0.."
rem Heap CEILING, not an allocation - small machines are unaffected (Node only
rem grows the heap it uses). Sized for up to ~10 parallel university crawls
rem (CRAWL_CONCURRENCY=10 on a 64GB box); the dashboard-spawned engine computes
rem the same ceiling dynamically from CRAWL_CONCURRENCY.
set NODE_OPTIONS=--max-old-space-size=8192
:loop
corepack pnpm@9.12.0 --filter "@clg/crawler" start
echo [run-crawler] worker exited, restarting in 5s...
timeout /t 5 /nobreak >nul
goto loop
