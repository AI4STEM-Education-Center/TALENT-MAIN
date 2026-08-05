[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$TargetInstanceId,
  [Parameter(Mandatory)] [string]$TargetSshHost,
  [Parameter(Mandatory)] [string]$TargetKeyPath,
  [Parameter(Mandatory)] [string]$SubnetId,
  [Parameter(Mandatory)] [string]$GeneratorSecurityGroupId,
  [Parameter(Mandatory)] [string]$GeneratorKeyName,
  [Parameter(Mandatory)] [string]$GeneratorKeyPath,
  [string]$TargetUser = "admin",
  [string]$TargetEnvFile = "/home/admin/app/.env",
  [string]$Branch = "dev",
  [string]$Region = "us-east-1",
  [int]$TargetPort = 3002,
  [int]$Students = 120,
  [int]$Classes = 4,
  [ValidateSet("smoke", "load", "burst", "stress", "soak", "message")]
  [string]$Profile = "load",
  [int]$Rate = 5,
  [string]$Duration = "30m",
  [switch]$KeepGenerator
)

$ErrorActionPreference = "Stop"
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw "aws CLI is required" }
$targetPrivateIp = aws ec2 describe-instances `
  --region $Region `
  --instance-ids $TargetInstanceId `
  --query "Reservations[0].Instances[0].PrivateIpAddress" `
  --output text
if (-not $targetPrivateIp -or $targetPrivateIp -eq "None") {
  throw "Could not resolve a private IP for $TargetInstanceId"
}

$startedAt = (Get-Date).ToUniversalTime()
& (Join-Path $PSScriptRoot "prepare-target.ps1") `
  -HostName $TargetSshHost `
  -User $TargetUser `
  -KeyPath $TargetKeyPath `
  -EnvFile $TargetEnvFile `
  -Branch $Branch `
  -Port $TargetPort `
  -Students $Students `
  -Classes $Classes
if ($LASTEXITCODE -ne 0) { throw "Target setup failed" }

$generatorArgs = @{
  TargetUrl = "http://${targetPrivateIp}:$TargetPort"
  SubnetId = $SubnetId
  SecurityGroupId = $GeneratorSecurityGroupId
  KeyName = $GeneratorKeyName
  KeyPath = $GeneratorKeyPath
  Profile = $Profile
  Region = $Region
  Rate = $Rate
  Duration = $Duration
  RequestHost = "localhost"
}
if ($KeepGenerator) { $generatorArgs.KeepInstance = $true }
$failure = $null
try {
  & (Join-Path $PSScriptRoot "run-generator.ps1") @generatorArgs
  if ($LASTEXITCODE -ne 0) { throw "Generator exited with $LASTEXITCODE" }
} catch {
  $failure = $_
} finally {
  $diagnosticsDir = Join-Path $PSScriptRoot "..\results\target-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  & (Join-Path $PSScriptRoot "collect-target.ps1") `
    -InstanceId $TargetInstanceId `
    -HostName $TargetSshHost `
    -KeyPath $TargetKeyPath `
    -StartedAt $startedAt `
    -OutputDir $diagnosticsDir `
    -User $TargetUser `
    -Region $Region
  Write-Host "Target diagnostics: $diagnosticsDir"
}
if ($failure) { throw $failure }
