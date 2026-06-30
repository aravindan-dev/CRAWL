@echo off
rem Start the API server. Portable: resolves the repo root from this script's path.
cd /d "%~dp0.."
corepack pnpm@9.12.0 --filter "@clg/api" start
