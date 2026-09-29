# Start the AREE backend (FastAPI).
#
# NOTE: the direct engine is the default and runs on Windows. Only the optional
# Pathway streaming engine needs Linux/macOS (WSL or Docker).

param(
    [int]$Port = 8000,
    [switch]$Reload
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$python = Join-Path $PSScriptRoot "venv\Scripts\python.exe"
if (-not (Test-Path $python)) { $python = "python" }

# Seed the store on first run, mirroring docker-entrypoint.sh: data/aree.db is
# gitignored, so a fresh clone has no replay moments. Copied ONLY when absent -
# an existing store may hold accumulated observations and is never overwritten.
$dbPath = if ($env:AREE_DB_PATH) { $env:AREE_DB_PATH } else { Join-Path $PSScriptRoot "data\aree.db" }
$seed = Join-Path $PSScriptRoot "backend\tests\fixtures\aree_test.db"
if (-not (Test-Path $dbPath)) {
    if (Test-Path $seed) {
        New-Item -ItemType Directory -Force (Split-Path $dbPath) | Out-Null
        Copy-Item $seed $dbPath
        Write-Host "No store at $dbPath - seeded from the committed fixture (replay works now)."
    } else {
        Write-Warning "No store at $dbPath and no seed fixture; forecasts will be unavailable."
    }
}

$args = @("-m", "uvicorn", "backend.api.main:api", "--host", "0.0.0.0", "--port", "$Port")
if ($Reload) { $args += "--reload" }

Write-Host "Starting AREE API on http://localhost:$Port (docs at /docs)"
& $python @args
