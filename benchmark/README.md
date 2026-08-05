# GPT-5.6 Realistic Performance Benchmark

This suite replaces the legacy endpoint blaster with repeatable user workflows for the current Next.js, SQLite, Honker worker, S3, and Cloudflare deployment. It supports local regression runs, low-volume public dev checks, isolated EC2 capacity tests, classroom quiz bursts, stress tests, four-hour soaks, message fan-out, real credential-login tests, and browser-level checks.

## Safety model

- Fixture generation refuses to run unless `BENCHMARK_ALLOW_MUTATION=1` and `APP_ENV` is exactly `benchmark`, `perf`, or `test`.
- Generated rows use the `gpt56_benchmark_` username prefix. Re-seeding deletes only users inside that prefix and recreates the disposable fixture.
- `benchmark/fixture.json` contains passwords and signed sessions. It is gitignored and must be treated as a secret.
- EC2 setup uses a dedicated `perf.db`, Docker project, port, and S3 prefix. It never mounts the production or dev database directory.
- Fixture generation also rejects database URLs that look like the production `prod.db` path.
- The EC2 load generator is a separate, temporary instance and is terminated automatically unless `-KeepInstance` is supplied.
- Do not point a stress or soak profile at the shared dev/production EC2 host. Use the isolated performance stack on a dedicated target instance.

## Workload model

The mixed workload starts with a provisional real-world distribution until route analytics provide a measured mix:

- 40% student dashboard, class, and notification browsing.
- 30% complete quiz attempts, including result creation and worker enqueueing.
- 15% teacher dashboard, roster, and statistics reads.
- 15% notification read/write activity.

Think time is modeled but scaled to keep local smoke tests short. Set `TIME_SCALE=1` for wall-clock-realistic pacing. Quiz bursts, message fan-out, and credential-login storms are separate profiles so their write amplification and rate-limit behavior remain visible.

## Local setup

Run the application as a production build or Docker image, not with `next dev`.

```powershell
$env:DATABASE_URL = "file:./data/benchmark.db"
$env:AUTH_SECRET = "benchmark-only-secret-with-at-least-32-characters"
$env:APP_ENV = "benchmark"
$env:BENCHMARK_ALLOW_MUTATION = "1"
npm run db:push
npm run benchmark:seed
```

Then run a profile. The wrapper uses a local k6 executable when present and otherwise uses the pinned `grafana/k6:2.0.0` Docker image.

```powershell
./benchmark/run.ps1 -Profile smoke -BaseUrl http://localhost:3000
./benchmark/run.ps1 -Profile load -BaseUrl http://localhost:3000 -Rate 3 -Duration 15m
./benchmark/run.ps1 -Profile burst -BaseUrl http://localhost:3000
./benchmark/run.ps1 -Profile stress -BaseUrl http://localhost:3000 -Rate 5
./benchmark/run.ps1 -Profile soak -BaseUrl http://localhost:3000 -Rate 3 -Duration 4h
./benchmark/run.ps1 -Profile message -BaseUrl http://localhost:3000
```

Useful fixture scale variables are `BENCHMARK_STUDENTS`, `BENCHMARK_CLASSES`, `BENCHMARK_QUIZZES`, `BENCHMARK_QUESTIONS`, and `BENCHMARK_HISTORY`. `RATE` is workflow arrivals per second, not raw HTTP requests per second.

### Login and browser passes

Capacity runs use per-user Auth.js sessions created by the fixture generator. This exercises authenticated middleware on every request without turning the application’s ten-logins-per-IP abuse control into the capacity limit.

Test the actual CSRF and password-login path separately:

```powershell
docker run --rm -v "${PWD}:/work" -w /work grafana/k6:2.0.0 run `
  -e BASE_URL=http://host.docker.internal:3000 `
  -e FIXTURE=./benchmark/fixture.json `
  /work/benchmark/k6/login-storm.js
```

Run the browser script with a local k6 installation and Chromium:

```powershell
k6 run -e BASE_URL=http://localhost:3000 -e FIXTURE=./benchmark/fixture.json benchmark/k6/browser.js
```

## Automated isolated EC2 run

For the most automated path, use the combined wrapper. It resolves the target's private IP, prepares the isolated target stack, downloads its signed fixture, provisions a separate generator, runs k6, retrieves artifacts, collects target Docker/log and EC2 CloudWatch diagnostics, and terminates the generator:

```powershell
./benchmark/ec2/run-full.ps1 `
  -TargetInstanceId i-0123456789abcdef0 `
  -TargetSshHost 203.0.113.10 `
  -TargetKeyPath C:\keys\target.pem `
  -SubnetId subnet-0123456789abcdef0 `
  -GeneratorSecurityGroupId sg-0123456789abcdef0 `
  -GeneratorKeyName talent-benchmark `
  -GeneratorKeyPath C:\keys\talent-benchmark.pem `
  -Branch codex/gpt-5-6-realistic-performance-benchmark `
  -Profile load -Rate 5 -Duration 30m
```

The target security group must allow TCP 3002 from the generator security group. The detailed stages below are also independently runnable for troubleshooting.

### 1. Prepare the target

The wrapper connects to a target EC2 instance, clones the requested branch, builds the fixture container, resets only the isolated performance database, starts isolated web and worker containers, waits for readiness, and downloads the generated fixture.

```powershell
./benchmark/ec2/prepare-target.ps1 `
  -HostName 203.0.113.10 `
  -User admin `
  -KeyPath C:\keys\talent.pem `
  -EnvFile /home/admin/app/.env `
  -Branch codex/gpt-5-6-realistic-performance-benchmark `
  -Students 120 `
  -Classes 4
```

The performance service listens on port 3002 by default. Keep that port private and reachable only from the load-generator security group. The target needs Docker, Git, curl, access to GHCR, and the existing application `.env`; `prepare-target.sh` performs the remaining setup.

### 2. Launch an ephemeral generator and run k6

The generator wrapper resolves the current Amazon Linux 2023 AMI, launches a tagged EC2 instance, installs Docker, transfers only the k6 suite and fixture, runs the selected profile, retrieves JSON/log artifacts, and terminates the instance in a `finally` block.

```powershell
./benchmark/ec2/run-generator.ps1 `
  -TargetUrl http://10.0.1.25:3002 `
  -RequestHost localhost `
  -SubnetId subnet-0123456789abcdef0 `
  -SecurityGroupId sg-0123456789abcdef0 `
  -KeyName talent-benchmark `
  -KeyPath C:\keys\talent-benchmark.pem `
  -Profile load `
  -Rate 5 `
  -Duration 30m
```

Requirements on the operator machine are authenticated AWS CLI, `ssh`, and `scp`. The subnet must assign public IPv4 addresses for the automation’s SSH connection. For private-only subnets, run the same scripts from a bastion or adapt the transport to SSM.

Artifacts are written under `benchmark/results/<run-id>/`. AWS charges continue if `-KeepInstance` is used.

### 3. Verify data integrity

On the target, run the verifier through the seed image after the queues have had time to drain:

```bash
cd ~/talent-performance/source
export PERF_ENV_FILE=/home/admin/app/.env
export PERF_DATA_DIR=~/talent-performance/data
export PERF_ARTIFACT_DIR=~/talent-performance/artifacts
docker compose --project-name talent-perf -f benchmark/ec2/docker-compose.perf.yml \
  run --rm seed npx tsx benchmark/verify.ts /artifacts/fixture.json
```

The verification fails when completed attempts lack durable results or answers. Also inspect pending AI results, container restarts, SQLite busy/locked errors, queue drain time, and target CPU/memory/disk metrics before declaring the run successful.

### 4. Stop the target stack

```powershell
Get-Content ./benchmark/ec2/cleanup-target.sh -Raw | ssh -i C:\keys\talent.pem admin@203.0.113.10 `
  "PERF_ENV_FILE=/home/admin/app/.env bash -s"
```

Cleanup stops containers but deliberately retains the isolated database and artifacts under `~/talent-performance` for investigation and recovery.

## Pass criteria

The suite enforces these initial thresholds:

- Unexpected HTTP errors below 0.5%.
- p95 request latency below 750 ms and p99 below 1.5 seconds.
- Quiz start p95 below 1.25 seconds.
- Quiz submission p95 below 2 seconds.
- Zero dropped arrival-rate iterations.
- Browser p75 LCP below 2.5 seconds, INP below 200 ms, and CLS below 0.1.

Treat the highest 30-minute rate satisfying all thresholds, integrity checks, queue-drain expectations, and infrastructure limits as measured capacity. Production planning should retain at least 20% headroom below that rate.
