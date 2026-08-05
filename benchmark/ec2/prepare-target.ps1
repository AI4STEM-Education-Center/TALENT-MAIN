[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$HostName,
  [Parameter(Mandatory)] [string]$KeyPath,
  [string]$User = "admin",
  [string]$EnvFile = "/home/admin/app/.env",
  [string]$Branch = "dev",
  [string]$Image = "ghcr.io/ai4stem-education-center/talent-main:dev-latest",
  [int]$Port = 3002,
  [int]$Students = 60,
  [int]$Classes = 2,
  [string]$FixtureOut = "benchmark/fixture.json"
)

$ErrorActionPreference = "Stop"
$scriptPath = Join-Path $PSScriptRoot "prepare-target.sh"
$sshArgs = @("-o", "StrictHostKeyChecking=accept-new", "-i", $KeyPath)
$remote = "PERF_ENV_FILE='$EnvFile' PERF_BRANCH='$Branch' PERF_IMAGE='$Image' PERF_PORT='$Port' BENCHMARK_STUDENTS='$Students' BENCHMARK_CLASSES='$Classes' bash -s"
Get-Content -LiteralPath $scriptPath -Raw | & ssh @sshArgs "${User}@${HostName}" $remote
if ($LASTEXITCODE -ne 0) { throw "Target preparation failed" }

$fixturePath = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path $FixtureOut)
$fixtureParent = Split-Path -Parent $fixturePath
New-Item -ItemType Directory -Force -Path $fixtureParent | Out-Null
& scp @sshArgs "${User}@${HostName}:~/talent-performance/artifacts/fixture.json" $fixturePath
if ($LASTEXITCODE -ne 0) { throw "Could not retrieve generated fixture" }
Write-Host "Target ready and fixture downloaded to $fixturePath"
