Param(
  [string]$WebBaseUrl = "http://127.0.0.1:3000",
  [string]$GoBaseUrl = "http://127.0.0.1:8090",
  [string]$QdrantUrl = "",
  [string]$TikaUrl = ""
)

$ErrorActionPreference = "Stop"

function Test-JsonEndpoint {
  Param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Url
  )
  try {
    $resp = Invoke-RestMethod -Method Get -Uri $Url -TimeoutSec 5
    Write-Host "[ok] $Name -> $Url"
    return @{
      name   = $Name
      url    = $Url
      ok     = $true
      result = $resp
    }
  } catch {
    Write-Host "[fail] $Name -> $Url"
    return @{
      name  = $Name
      url   = $Url
      ok    = $false
      error = $_.Exception.Message
    }
  }
}

$results = @()
$results += Test-JsonEndpoint -Name "web" -Url "$WebBaseUrl/api/auth/session"
$results += Test-JsonEndpoint -Name "go" -Url "$GoBaseUrl/healthz"

if ($QdrantUrl -and $QdrantUrl.Trim().Length -gt 0) {
  $results += Test-JsonEndpoint -Name "qdrant" -Url "$($QdrantUrl.TrimEnd('/'))/collections"
}

if ($TikaUrl -and $TikaUrl.Trim().Length -gt 0) {
  $results += Test-JsonEndpoint -Name "tika" -Url "$($TikaUrl.TrimEnd('/'))/version"
}

$failed = @($results | Where-Object { -not $_.ok })

Write-Host ""
Write-Host "Health summary:"
$results | ForEach-Object {
  if ($_.ok) {
    Write-Host "  - $($_.name): ok ($($_.url))"
  } else {
    Write-Host "  - $($_.name): fail ($($_.url)) -> $($_.error)"
  }
}

if ($failed.Count -gt 0) {
  throw "health check failed: $($failed.Count) endpoint(s) not ready"
}
