[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$TargetUrl,
  [Parameter(Mandatory)] [string]$SubnetId,
  [Parameter(Mandatory)] [string]$SecurityGroupId,
  [Parameter(Mandatory)] [string]$KeyName,
  [Parameter(Mandatory)] [string]$KeyPath,
  [string]$Fixture = "benchmark/fixture.json",
  [ValidateSet("smoke", "load", "burst", "stress", "soak", "message")]
  [string]$Profile = "load",
  [string]$Region = "us-east-1",
  [string]$InstanceType = "c7i.large",
  [string]$K6Image = "grafana/k6:2.0.0",
  [string]$RequestHost = "",
  [int]$Rate = 3,
  [string]$Duration = "",
  [switch]$KeepInstance
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$fixturePath = (Resolve-Path (Join-Path $repo $Fixture)).Path
$runId = "gpt56-benchmark-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$resultDir = Join-Path $PSScriptRoot "..\results\$runId"
New-Item -ItemType Directory -Force -Path $resultDir | Out-Null

foreach ($command in @("aws", "ssh", "scp")) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$command is required" }
}

$null = aws sts get-caller-identity --region $Region | ConvertFrom-Json
$ami = aws ssm get-parameter --region $Region --name "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64" --query "Parameter.Value" --output text
$userDataPath = Join-Path ([IO.Path]::GetTempPath()) "$runId-user-data.sh"
@"
#!/bin/bash
set -euxo pipefail
dnf install -y docker git
systemctl enable --now docker
usermod -aG docker ec2-user
mkdir -p /home/ec2-user/benchmark/results
chown -R ec2-user:ec2-user /home/ec2-user/benchmark
"@ | Set-Content -LiteralPath $userDataPath -Encoding utf8NoBOM

$instanceId = $null
try {
  $instanceId = aws ec2 run-instances `
    --region $Region `
    --image-id $ami `
    --instance-type $InstanceType `
    --subnet-id $SubnetId `
    --security-group-ids $SecurityGroupId `
    --key-name $KeyName `
    --user-data "file://$userDataPath" `
    --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=20,VolumeType=gp3,DeleteOnTermination=true}' `
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$runId},{Key=Purpose,Value=ephemeral-load-generator},{Key=CreatedBy,Value=GPT-5.6}]" `
    --query "Instances[0].InstanceId" `
    --output text
  if (-not $instanceId) { throw "AWS did not return an instance id" }
  Write-Host "Provisioned load generator $instanceId"
  aws ec2 wait instance-status-ok --region $Region --instance-ids $instanceId
  $hostName = aws ec2 describe-instances --region $Region --instance-ids $instanceId --query "Reservations[0].Instances[0].PublicDnsName" --output text
  if (-not $hostName -or $hostName -eq "None") { throw "Generator has no public DNS name; use a subnet with public IPv4 access" }

  $sshArgs = @("-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", "-i", $KeyPath)
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    & ssh @sshArgs "ec2-user@$hostName" "cloud-init status --wait && docker version" 2>$null
    if ($LASTEXITCODE -eq 0) { break }
    if ($attempt -eq 29) { throw "SSH or cloud-init did not become ready" }
    Start-Sleep -Seconds 10
  }

  & scp @sshArgs -r (Join-Path $repo "benchmark\k6") "ec2-user@${hostName}:/home/ec2-user/benchmark/"
  & scp @sshArgs $fixturePath "ec2-user@${hostName}:/home/ec2-user/benchmark/fixture.json"
  if ($LASTEXITCODE -ne 0) { throw "Failed to transfer benchmark suite" }

  $durationEnv = if ($Duration) { "-e DURATION='$Duration'" } else { "" }
  $hostEnv = if ($RequestHost) { "-e REQUEST_HOST='$RequestHost'" } else { "" }
  $remote = @"
set -euo pipefail
mkdir -p /home/ec2-user/benchmark/results
docker run --rm --network host -v /home/ec2-user/benchmark:/work/benchmark -w /work '$K6Image' run \
  -e PROFILE='$Profile' -e BASE_URL='$TargetUrl' -e FIXTURE=./benchmark/fixture.json -e RATE='$Rate' $durationEnv $hostEnv \
  --summary-export /work/benchmark/results/summary.json /work/benchmark/k6/workflows.js 2>&1 | tee /home/ec2-user/benchmark/results/k6.log
uname -a > /home/ec2-user/benchmark/results/generator.txt
docker version >> /home/ec2-user/benchmark/results/generator.txt
"@
  & ssh @sshArgs "ec2-user@$hostName" $remote
  $testExit = $LASTEXITCODE
  & scp @sshArgs -r "ec2-user@${hostName}:/home/ec2-user/benchmark/results/." $resultDir
  Write-Host "Artifacts: $resultDir"
  if ($testExit -ne 0) { throw "k6 thresholds failed (exit $testExit); artifacts were retained" }
} finally {
  Remove-Item -LiteralPath $userDataPath -ErrorAction SilentlyContinue
  if ($instanceId -and -not $KeepInstance) {
    aws ec2 terminate-instances --region $Region --instance-ids $instanceId | Out-Null
    Write-Host "Terminated ephemeral generator $instanceId"
  } elseif ($instanceId) {
    Write-Warning "Generator retained: $instanceId (charges continue)"
  }
}
