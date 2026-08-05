[CmdletBinding()]
param(
  [ValidateSet("smoke", "load", "burst", "stress", "soak", "message")]
  [string]$Profile = "smoke",
  [string]$BaseUrl = "http://localhost:3000",
  [string]$Fixture = "benchmark/fixture.json",
  [int]$Rate = 3,
  [string]$Duration = "",
  [string]$K6Image = "grafana/k6:2.0.0"
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$results = Join-Path $PSScriptRoot "results"
New-Item -ItemType Directory -Force -Path $results | Out-Null
$fixturePath = (Resolve-Path (Join-Path $repo $Fixture)).Path
$fixtureRelative = $fixturePath.Substring($repo.Length).TrimStart("\", "/").Replace("\", "/")
$durationArgs = if ($Duration) { @("-e", "DURATION=$Duration") } else { @() }
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$summary = "/work/benchmark/results/$timestamp-$Profile-summary.json"

if (Get-Command k6 -ErrorAction SilentlyContinue) {
  Push-Location $repo
  try {
    & k6 run -e "PROFILE=$Profile" -e "BASE_URL=$BaseUrl" -e "FIXTURE=./$fixtureRelative" -e "RATE=$Rate" @durationArgs --summary-export ".\benchmark\results\$timestamp-$Profile-summary.json" ".\benchmark\k6\workflows.js"
  } finally {
    Pop-Location
  }
  exit $LASTEXITCODE
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Install k6 or Docker. The runner found neither."
}

$dockerDuration = if ($Duration) { @("-e", "DURATION=$Duration") } else { @() }
& docker run --rm -i `
  -v "${repo}:/work" `
  -w /work `
  $K6Image run `
  -e "PROFILE=$Profile" `
  -e "BASE_URL=$BaseUrl" `
  -e "FIXTURE=./$fixtureRelative" `
  -e "RATE=$Rate" `
  @dockerDuration `
  --summary-export $summary `
  /work/benchmark/k6/workflows.js
exit $LASTEXITCODE
