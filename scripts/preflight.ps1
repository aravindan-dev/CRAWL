<#
  CLG Search - environment & port preflight.

  One source of truth for host ports. Runs before setup/start so the API port
  (and every URL derived from it) is always consistent across .env, the web
  dashboard, docker-compose and the launcher scripts.

  What it does (idempotent, safe to run repeatedly):
    1. Ensures a host-correct .env exists (creates one from .env.example if
       missing, rewriting docker-internal hostnames to localhost).
    2. Picks the host ports (postgres/redis/api/web). A value already present in
       .env is trusted as-is; a missing one is filled with the first FREE port
       at/after its standard default so a fresh PC never collides with software
       already using 5432/6379/4000/3000.
    3. Rewrites DATABASE_URL, REDIS_URL and NEXT_PUBLIC_API_URL from those ports
       so they can never drift out of sync (comments in .env are preserved).
    4. Mirrors NEXT_PUBLIC_API_URL into apps/web/.env.local.
    5. Emits scripts/ports.bat (set KEY=VALUE lines) so the .bat launchers read
       the exact same ports without fragile .env parsing.
#>
param(
  [Parameter(Mandatory = $true)][string]$Root
)

$ErrorActionPreference = "Stop"
$envPath      = Join-Path $Root ".env"
$examplePath  = Join-Path $Root ".env.example"
$webEnvLocal  = Join-Path $Root "apps\web\.env.local"
$portsBat     = Join-Path $Root "scripts\ports.bat"

function Test-PortInUse([int]$Port) {
  try {
    $c = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop
    return ($null -ne $c)
  } catch [Microsoft.PowerShell.Cmdletization.Cim.CimJobException] {
    return $false            # no listener => cmdlet throws "not found"
  } catch {
    # Older boxes without Get-NetTCPConnection: fall back to netstat.
    $hit = netstat -ano -p tcp | Select-String -SimpleMatch ":$Port " |
           Select-String -SimpleMatch "LISTENING"
    return [bool]$hit
  }
}

function Get-FreePort([int]$Preferred) {
  $p = $Preferred
  while (Test-PortInUse $p) { $p++ ; if ($p -gt $Preferred + 200) { break } }
  return $p
}

# Windows PowerShell 5.1's `Set-Content -Encoding utf8` writes a BOM and can
# re-encode multi-byte chars. Write plain UTF-8 (no BOM) to keep .env clean.
function Write-Utf8NoBom([string]$Path, [string[]]$Content) {
  $text = ($Content -join "`r`n") + "`r`n"
  [System.IO.File]::WriteAllText($Path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

# --- 1. Ensure .env exists (host-correct) ---------------------------------
if (-not (Test-Path $envPath)) {
  if (Test-Path $examplePath) {
    # Copy the example but flip docker-internal hostnames to localhost, because
    # start.bat runs the apps on the HOST (only Postgres/Redis live in Docker).
    $adjusted = @(Get-Content -Path $examplePath -Encoding UTF8) |
      ForEach-Object {
        $_ -replace '@postgres:', '@localhost:' -replace 'redis://redis:', 'redis://localhost:'
      }
    Write-Utf8NoBom $envPath $adjusted
    Write-Host "  created .env from .env.example (host-adjusted)"
  } else {
    New-Item -ItemType File -Path $envPath | Out-Null
    Write-Host "  created empty .env"
  }
}

$lines = @(Get-Content -Path $envPath -Encoding UTF8)

function Get-EnvVal([string]$Key) {
  foreach ($l in $script:lines) {
    if ($l -match "^\s*$([regex]::Escape($Key))\s*=\s*(.*)$") { return $Matches[1].Trim() }
  }
  return $null
}

function Set-EnvVal([string]$Key, [string]$Value) {
  $pattern = "^\s*$([regex]::Escape($Key))\s*="
  if (@($script:lines | Where-Object { $_ -match $pattern }).Count -gt 0) {
    $script:lines = $script:lines | ForEach-Object { if ($_ -match $pattern) { "$Key=$Value" } else { $_ } }
  } else {
    $script:lines += "$Key=$Value"
  }
}

# --- 2. Resolve host ports (trust existing, free-pick the missing) --------
function Resolve-Port([string]$Key, [int]$Default) {
  $cur = Get-EnvVal $Key
  if ($cur -and ($cur -match '^\d+$')) { return [int]$cur }
  $free = Get-FreePort $Default
  Set-EnvVal $Key "$free"
  if ($free -ne $Default) {
    Write-Host "  $Key default $Default is busy -> using $free"
  }
  return $free
}

$pgPort  = Resolve-Port "POSTGRES_HOST_PORT" 5432
$rdPort  = Resolve-Port "REDIS_HOST_PORT"    6379
$apiPort = Resolve-Port "API_PORT"           4000
$webPort = Resolve-Port "WEB_PORT"           3000

# --- 3. Derive URLs from the ports so they can never drift -----------------
# (docker-compose overrides DATABASE_URL/REDIS_URL for its own containers, so
#  localhost values here are correct for the host-run apps and harmless to the
#  full-docker path.)
Set-EnvVal "DATABASE_URL"        "postgresql://postgres:postgres@localhost:$pgPort/clgsearch"
Set-EnvVal "REDIS_URL"           "redis://localhost:$rdPort"
Set-EnvVal "NEXT_PUBLIC_API_URL" "http://localhost:$apiPort"

Write-Utf8NoBom $envPath $lines

# --- 4. Mirror the API URL into the web app's local env --------------------
New-Item -ItemType Directory -Force -Path (Split-Path $webEnvLocal) | Out-Null
Write-Utf8NoBom $webEnvLocal @("NEXT_PUBLIC_API_URL=http://localhost:$apiPort")

# --- 5. Emit ports.bat for the launcher scripts ----------------------------
@(
  "@echo off",
  "rem AUTO-GENERATED by scripts\preflight.ps1 - do not edit.",
  "set `"POSTGRES_HOST_PORT=$pgPort`"",
  "set `"REDIS_HOST_PORT=$rdPort`"",
  "set `"API_PORT=$apiPort`"",
  "set `"WEB_PORT=$webPort`""
) | Set-Content -Path $portsBat -Encoding ascii

Write-Host "  ports: postgres=$pgPort redis=$rdPort api=$apiPort web=$webPort"
Write-Host "  api url: http://localhost:$apiPort   dashboard: http://localhost:$webPort"
