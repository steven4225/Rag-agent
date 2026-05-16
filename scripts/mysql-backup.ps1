Param(
  [string]$MySQLHost = "127.0.0.1",
  [int]$MySQLPort = 3306,
  [string]$MySQLUser = "root",
  [string]$MySQLPassword = "",
  [string]$MySQLDatabase = "",
  [string]$OutputDir = "",
  [string]$Label = "",
  [string]$MySQLBin = "mysql",
  [string]$MySQLDumpBin = "mysqldump"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($MySQLDatabase)) {
  throw "MySQLDatabase is required"
}

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $repoRoot "tmp\recovery-drill\backups"
}
if ([string]::IsNullOrWhiteSpace($Label)) {
  $Label = Get-Date -Format "yyyyMMdd-HHmmss"
}

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

$backupFile = Join-Path $OutputDir ("mysql-backup-" + $Label + ".sql")
$metadataFile = Join-Path $OutputDir ("mysql-backup-" + $Label + ".json")
$stderrFile = Join-Path $OutputDir ("mysql-backup-" + $Label + ".stderr.log")

$tables = @("ingestion_tasks", "index_metadata_records")

function Build-MySqlAuthArgs {
  Param(
    [string]$DbHost,
    [int]$DbPort,
    [string]$DbUser,
    [string]$DbPassword
  )

  $args = @(
    "--protocol=TCP",
    "--host=$DbHost",
    "--port=$DbPort",
    "--user=$DbUser"
  )
  if (-not [string]::IsNullOrWhiteSpace($DbPassword)) {
    $args += "--password=$DbPassword"
  }
  return $args
}

function Invoke-MySqlScalar {
  Param(
    [string]$Sql,
    [string[]]$AuthArgs
  )

  $queryArgs = @()
  $queryArgs += $AuthArgs
  $queryArgs += @(
    "--database=$MySQLDatabase",
    "--batch",
    "--raw",
    "--skip-column-names",
    "--execute=$Sql"
  )

  $result = & $MySQLBin @queryArgs
  if ($LASTEXITCODE -ne 0) {
    throw "mysql query failed: $Sql"
  }
  return [string]::Join("", $result).Trim()
}

$authArgs = Build-MySqlAuthArgs -DbHost $MySQLHost -DbPort $MySQLPort -DbUser $MySQLUser -DbPassword $MySQLPassword

$rowCounts = @{}
foreach ($table in $tables) {
  $countSql = "SELECT COUNT(1) FROM $table;"
  $rowCounts[$table] = [int](Invoke-MySqlScalar -Sql $countSql -AuthArgs $authArgs)
}

$dumpArgs = @()
$dumpArgs += $authArgs
$dumpArgs += @(
  "--set-gtid-purged=OFF",
  "--single-transaction",
  "--skip-lock-tables",
  "--skip-comments",
  "--no-tablespaces",
  "--databases",
  $MySQLDatabase,
  "--tables"
)
$dumpArgs += $tables

$proc = Start-Process -FilePath $MySQLDumpBin `
  -ArgumentList $dumpArgs `
  -Wait `
  -NoNewWindow `
  -PassThru `
  -RedirectStandardOutput $backupFile `
  -RedirectStandardError $stderrFile

if ($proc.ExitCode -ne 0) {
  $stderr = ""
  if (Test-Path $stderrFile) {
    $stderr = Get-Content $stderrFile -Raw
  }
  throw "mysqldump failed with exit code $($proc.ExitCode): $stderr"
}

$sha = (Get-FileHash -Path $backupFile -Algorithm SHA256).Hash
$size = (Get-Item $backupFile).Length

$metadata = @{
  generatedAt = (Get-Date).ToString("o")
  label = $Label
  mysql = @{
    host = $MySQLHost
    port = $MySQLPort
    user = $MySQLUser
    database = $MySQLDatabase
  }
  tables = $tables
  rowCounts = $rowCounts
  backupFile = $backupFile
  backupSha256 = $sha
  backupSizeBytes = $size
}

$metadata | ConvertTo-Json -Depth 8 | Set-Content -Path $metadataFile -Encoding UTF8

[pscustomobject]@{
  BackupFile = $backupFile
  MetadataFile = $metadataFile
  Tables = $tables
  RowCounts = $rowCounts
  BackupSha256 = $sha
  BackupSizeBytes = $size
}
