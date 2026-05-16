Param(
  [string]$WebDir = "web"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$targetWebDir = Join-Path $repoRoot $WebDir

if (-not (Test-Path $targetWebDir)) {
  throw "web directory not found: $targetWebDir"
}

Write-Host "[smoke] running verify:smoke-phase1 in $targetWebDir"
Push-Location $targetWebDir
try {
  & npm.cmd run verify:smoke-phase1
  if ($LASTEXITCODE -ne 0) {
    throw "smoke check failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}
