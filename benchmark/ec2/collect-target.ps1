[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$InstanceId,
  [Parameter(Mandatory)] [string]$HostName,
  [Parameter(Mandatory)] [string]$KeyPath,
  [Parameter(Mandatory)] [datetime]$StartedAt,
  [Parameter(Mandatory)] [string]$OutputDir,
  [string]$User = "admin",
  [string]$Region = "us-east-1"
)

$ErrorActionPreference = "Continue"
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$sshArgs = @("-o", "StrictHostKeyChecking=accept-new", "-i", $KeyPath)
$remoteSnapshot = @'
date -u
uptime
free -m
df -h
docker stats --no-stream
docker compose --project-name talent-perf -f "$HOME/talent-performance/source/benchmark/ec2/docker-compose.perf.yml" ps
docker compose --project-name talent-perf -f "$HOME/talent-performance/source/benchmark/ec2/docker-compose.perf.yml" logs --tail 300 web-perf worker-perf
'@
(& ssh @sshArgs "${User}@${HostName}" $remoteSnapshot 2>&1) |
  Out-File -LiteralPath (Join-Path $OutputDir "target-snapshot.log") -Encoding utf8

$start = $StartedAt.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$end = (Get-Date).ToUniversalTime().AddMinutes(2).ToString("yyyy-MM-ddTHH:mm:ssZ")
foreach ($metric in @("CPUUtilization", "NetworkIn", "NetworkOut", "DiskReadBytes", "DiskWriteBytes")) {
  $unit = if ($metric -eq "CPUUtilization") { "Percent" } else { "Bytes" }
  aws cloudwatch get-metric-statistics `
    --region $Region `
    --namespace AWS/EC2 `
    --metric-name $metric `
    --dimensions "Name=InstanceId,Value=$InstanceId" `
    --start-time $start `
    --end-time $end `
    --period 60 `
    --statistics Average Maximum `
    --unit $unit `
    --output json |
      Out-File -LiteralPath (Join-Path $OutputDir "cloudwatch-$metric.json") -Encoding utf8
}
