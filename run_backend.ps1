# Start the AREE backend (FastAPI + Pathway engine).
#
# NOTE: Pathway publishes Linux/macOS wheels only. On Windows the API starts but
# reports engine_unavailable; run the backend under WSL or Docker for live data.

param(
    [int]$Port = 8000,
    [switch]$Reload
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$python = Join-Path $PSScriptRoot "venv\Scripts\python.exe"
if (-not (Test-Path $python)) { $python = "python" }

$args = @("-m", "uvicorn", "backend.api.main:api", "--host", "0.0.0.0", "--port", "$Port")
if ($Reload) { $args += "--reload" }

Write-Host "Starting AREE API on http://localhost:$Port (docs at /docs)"
& $python @args
