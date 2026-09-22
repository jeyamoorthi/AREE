<#
.SYNOPSIS
    Serve the AREE demo from this machine through a Cloudflare quick tunnel.

.DESCRIPTION
    Starts the backend on 127.0.0.1:8102, the production frontend on
    127.0.0.1:3101 and a cloudflared quick tunnel in front of the frontend, then
    checks the public link from outside and prints it. The frontend proxies /api
    and /ws to the backend (frontend/next.config.ts), so one tunnel carries the
    whole application.

    WHY --protocol http2
        On the default QUIC transport the tunnel dropped after six minutes
        ("no recent network activity"), Cloudflare deleted it, and every
        reconnect then answered "Tunnel not found". A deleted quick tunnel never
        recovers. HTTP/2 over TCP 443 has held where QUIC did not.

    THE LINK CHANGES ON EVERY RUN, AND DIES IF THIS MACHINE SLEEPS. Under Modern
    Standby an idle screen-off cuts background network, which kills the tunnel.
    Keep the machine plugged in with sleep disabled while the link is shared.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\demo_tunnel.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\demo_tunnel.ps1 -Stop
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Stop
)

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
$Frontend = Join-Path $Root "frontend"
$Logs = Join-Path $Root ".tmp\demo"
$BackendPort = 8102
$FrontendPort = 3101

$Python = Join-Path $Root "venv\Scripts\python.exe"
if (-not (Test-Path $Python)) { $Python = (Get-Command python).Source }

function Stop-Demo {
    foreach ($port in $BackendPort, $FrontendPort) {
        Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
            ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    }
    # Only the tunnel this script starts. Any other cloudflared is left alone.
    Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" |
        Where-Object { $_.CommandLine -like "*127.0.0.1:$FrontendPort*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Wait-Until([scriptblock]$Test, [int]$Seconds, [string]$What) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $value = & $Test
            if ($value) { return $value }
        } catch { }
        Start-Sleep -Seconds 1
    }
    throw "timed out after $Seconds s waiting for $What - see the logs in $Logs"
}

function Start-Hidden([string]$File, [string[]]$Arguments, [string]$Directory, [string]$Name) {
    $options = @{
        FilePath               = $File
        ArgumentList           = $Arguments
        WorkingDirectory       = $Directory
        WindowStyle            = "Hidden"
        RedirectStandardOutput = Join-Path $Logs "$Name.out.log"
        RedirectStandardError  = Join-Path $Logs "$Name.err.log"
        PassThru               = $true
    }
    Start-Process @options
}

if ($Stop) {
    Stop-Demo
    Write-Host "AREE demo stopped."
    return
}

New-Item -ItemType Directory -Force $Logs | Out-Null
Stop-Demo    # a previous run would still hold the ports

# 1. The observations the hourly GitHub capture recorded while this machine was
#    off. Without them the live outlook answers 424 until the backend's own
#    repair has backfilled from OpenAQ, which takes minutes.
$env:AREE_DB_PATH = Join-Path $Root "data\aree.db"
git -C $Root pull --ff-only --quiet
if ($LASTEXITCODE -ne 0) { Write-Warning "git pull failed - importing the observations already on disk" }
& $Python (Join-Path $Root "tools\capture_csv.py") import

# 2. Backend.
$env:AREE_ENGINE_MODE = "direct"
$env:OMP_NUM_THREADS = "1"
$backend = Start-Hidden $Python @("-m", "uvicorn", "backend.api.main:api",
    "--host", "127.0.0.1", "--port", "$BackendPort") $Root "backend"
$null = Wait-Until {
    (Invoke-WebRequest "http://127.0.0.1:$BackendPort/api/health" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200
} 90 "the backend"

# 3. Frontend, rebuilt every run so a pull that changed it is never served stale.
#    next.config.ts reads AREE_API_ORIGIN, so it is set for both build and start.
$env:AREE_API_ORIGIN = "http://127.0.0.1:$BackendPort"
Push-Location $Frontend
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "frontend build failed" }
} finally {
    Pop-Location
}
$env:NODE_ENV = "production"
$frontendProcess = Start-Hidden (Get-Command node).Source @("node_modules\next\dist\bin\next", "start",
    "-p", "$FrontendPort", "-H", "127.0.0.1") $Frontend "frontend"
$null = Wait-Until {
    (Invoke-WebRequest "http://127.0.0.1:$FrontendPort/" -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200
} 90 "the frontend"

# 4. Tunnel.
$tunnel = Start-Hidden (Get-Command cloudflared).Source @("tunnel", "--no-autoupdate",
    "--protocol", "http2", "--url", "http://127.0.0.1:$FrontendPort") $Root "tunnel"
$tunnelLog = Join-Path $Logs "tunnel.err.log"
$url = Wait-Until {
    $text = Get-Content $tunnelLog -Raw -ErrorAction SilentlyContinue
    if ($text -match "Registered tunnel connection" -and
        $text -match "https://[a-z0-9-]+\.trycloudflare\.com") { $Matches[0] }
} 60 "the tunnel"

# 5. Check it from outside, the way a juror's browser will reach it.
$null = Wait-Until {
    (Invoke-WebRequest "$url/api/ready" -UseBasicParsing -TimeoutSec 10).StatusCode -eq 200
} 90 "the public link"
try {
    $null = Invoke-WebRequest "$url/api/aree/outlook" -UseBasicParsing -TimeoutSec 120
    $live = "Live outlook: OK"
} catch {
    $live = "Live outlook: not ready yet - the backend is repairing the observation store; recheck in a few minutes"
}

Write-Host ""
Write-Host "  AREE demo link:  $url" -ForegroundColor Green
Write-Host "  $live"
Write-Host "  processes: backend $($backend.Id), frontend $($frontendProcess.Id), tunnel $($tunnel.Id)"
Write-Host "  logs: $Logs"
Write-Host "  stop: powershell -ExecutionPolicy Bypass -File tools\demo_tunnel.ps1 -Stop"
Write-Host "  The link changes on every run and dies if this machine sleeps."
