# GPT-5.6 Realistic Performance Benchmark

This suite replaces the legacy endpoint blaster with repeatable user workflows for the current Next.js, SQLite, Honker worker, S3, and Cloudflare deployment. It supports local regression runs, low-volume public dev checks, isolated EC2 capacity tests, classroom quiz bursts, stress tests, four-hour soaks, message fan-out, real credential-login tests, and browser-level checks.

## Safety model

- Fixture generation refuses to run unless `BENCHMARK_ALLOW_MUTATION=1` and `APP_ENV` is exactly `benchmark`, `perf`, or `test`.
- Generated rows use the `gpt56_benchmark_` username prefix. Re-seeding deletes only users inside that prefix and recreates the disposable fixture.
- `benchmark/fixture.json` contains passwords and signed sessions. It is gitignored and must be treated as a secret.
- EC2 setup uses a dedicated `perf.db`, Docker project, port, and S3 prefix. It never mounts the production or dev database directory.
- Fixture generation also rejects database URLs that look like the production `prod.db` path.
- Local and dev entry points are Bash scripts supported on Linux and macOS. Windows and PowerShell wrappers are intentionally not maintained.
- EC2 runs execute k6 on the isolated target instance. This is convenient for smoke and regression checks, but generator and application resource contention makes it unsuitable for a clean maximum-capacity measurement.
- Do not point a stress or soak profile at the shared dev or production service. Use the isolated performance stack on a dedicated target instance.

## Workload model

The mixed workload starts with a provisional real-world distribution until route analytics provide a measured mix:

- 40% student dashboard, class, and notification browsing.
- 30% complete quiz attempts, including result creation and worker enqueueing.
- 15% teacher dashboard, roster, and statistics reads.
- 15% notification read/write activity.

Think time is modeled but scaled to keep local smoke tests short. Set `TIME_SCALE=1` for wall-clock-realistic pacing. Quiz bursts, message fan-out, and credential-login storms are separate profiles so their write amplification and rate-limit behavior remain visible.

## Local setup

Run the application as a production build or Docker image, not with `next dev`.

```bash
export DATABASE_URL="file:./data/benchmark.db"
export AUTH_SECRET="benchmark-only-secret-with-at-least-32-characters"
export APP_ENV="benchmark"
export BENCHMARK_ALLOW_MUTATION="1"
npm run db:push
npm run benchmark:seed
```

Then run a profile. The wrapper uses a local k6 executable when present and otherwise uses the pinned `grafana/k6:2.0.0` Docker image.

```bash
./benchmark/run.sh --profile smoke --base-url http://localhost:3000
./benchmark/run.sh --profile load --base-url http://localhost:3000 --rate 3 --duration 15m
./benchmark/run.sh --profile burst --base-url http://localhost:3000
./benchmark/run.sh --profile stress --base-url http://localhost:3000 --rate 5
./benchmark/run.sh --profile soak --base-url http://localhost:3000 --rate 3 --duration 4h
./benchmark/run.sh --profile message --base-url http://localhost:3000
```

The runner supports native k6 and falls back to Docker. For Docker-based local runs it translates loopback URLs to `host.docker.internal` on macOS and adds the Docker host-gateway mapping on Linux.

## Public dev endpoint

Use the same Bash runner for a low-volume smoke pass through the public dev edge:

```bash
./benchmark/run.sh \
  --profile smoke \
  --base-url https://dev.example.com \
  --fixture benchmark/fixture.json
```

The fixture must contain accounts and sessions valid for the target environment. Non-smoke profiles against any remote URL are blocked unless `--allow-remote-load` is supplied. That flag is an explicit operator acknowledgement; it does not make a shared target safe for load testing.

Useful fixture scale variables are `BENCHMARK_STUDENTS`, `BENCHMARK_CLASSES`, `BENCHMARK_QUIZZES`, `BENCHMARK_QUESTIONS`, and `BENCHMARK_HISTORY`. `RATE` is workflow arrivals per second, not raw HTTP requests per second.

### Login and browser passes

Capacity runs use per-user Auth.js sessions created by the fixture generator. This exercises authenticated middleware on every request without turning the application’s ten-logins-per-IP abuse control into the capacity limit.

Test the actual CSRF and password-login path separately:

```bash
docker run --rm -v "$PWD:/work" -w /work grafana/k6:2.0.0 run \
  -e BASE_URL=http://host.docker.internal:3000 \
  -e FIXTURE=./benchmark/fixture.json \
  /work/benchmark/k6/login-storm.js
```

Run the browser script with a local k6 installation and Chromium:

```powershell
k6 run -e BASE_URL=http://localhost:3000 -e FIXTURE=./benchmark/fixture.json benchmark/k6/browser.js
```

## Isolated EC2 options

Both supported EC2 entry points run the same checked-in Bash scripts directly on the instance. They create a separate Docker Compose project, `perf.db`, port, artifact directory, and S3 prefix under `~/talent-performance`.

### Option A: run directly over SSH

From a Linux or macOS operator machine, stream the trusted preparation script to the instance. It clones the selected ref, resets only the isolated performance database, creates the fixture, and starts the isolated web and worker containers:

```bash
ssh -i ~/.ssh/talent.pem admin@203.0.113.10 \
  "PERF_ENV_FILE=/home/admin/app/.env \
   PERF_BRANCH=dev \
   BENCHMARK_STUDENTS=120 \
   BENCHMARK_CLASSES=4 \
   bash -s" \
  < benchmark/ec2/prepare-target.sh
```

Then execute k6 on that instance:

```bash
ssh -i ~/.ssh/talent.pem admin@203.0.113.10 \
  "PROFILE=load RATE=5 DURATION=30m \
   bash ~/talent-performance/source/benchmark/ec2/run-on-instance.sh"
```

Copy the results back after the run:

```bash
scp -i ~/.ssh/talent.pem -r \
  admin@203.0.113.10:talent-performance/results/ ./benchmark/results/ec2/
```

The performance service listens only for the duration of the retained Compose stack on port 3002 by default. Restrict that port at the security-group level even though a direct run uses instance loopback.

### Option B: manual GitHub Actions trigger

The `EC2 Performance Benchmark` workflow exposes the same operation through `workflow_dispatch`. Configure these repository or `performance-benchmark` environment secrets:

- `EC2_HOST`: SSH hostname or address for the isolated target.
- `EC2_USER`: target Linux user, such as `admin`.
- `EC2_SSH_KEY`: private SSH key for that user.
- `EC2_PERF_ENV_FILE`: optional absolute target `.env` path; defaults to `/home/<EC2_USER>/app/.env`.

In GitHub Actions, select **EC2 Performance Benchmark**, choose **Run workflow**, select the profile, and confirm the isolated reset. The workflow deliberately benchmarks only the protected `dev` branch so an arbitrary ref cannot receive deployment credentials. Runs are serialized, capped at six hours, and upload k6, verification, Compose, and host diagnostics for 14 days. Put approval rules on the `performance-benchmark` GitHub environment if only designated operators should be able to start a run.

The workflow appears in the Actions UI after the workflow file exists on the repository's default branch. Until then, use Option A from the PR branch.

### Verify data integrity manually

`run-on-instance.sh` runs this verifier automatically after k6. To rerun it manually after the queues have had time to drain:

```bash
cd ~/talent-performance/source
export PERF_ENV_FILE=/home/admin/app/.env
export PERF_DATA_DIR=~/talent-performance/data
export PERF_ARTIFACT_DIR=~/talent-performance/artifacts
docker compose --project-name talent-perf -f benchmark/ec2/docker-compose.perf.yml \
  run --rm seed npx tsx benchmark/verify.ts /artifacts/fixture.json
```

The verification fails when completed attempts lack durable results or answers. Also inspect pending AI results, container restarts, SQLite busy/locked errors, queue drain time, and target CPU/memory/disk metrics before declaring the run successful.

### Stop the target stack

```bash
ssh -i ~/.ssh/talent.pem admin@203.0.113.10 \
  "PERF_ENV_FILE=/home/admin/app/.env bash -s" \
  < benchmark/ec2/cleanup-target.sh
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

Because the supported EC2 paths run k6 on the application host, use them for regression comparisons and operational checks rather than a definitive saturation ceiling. A separate load-generator host is the better option when measuring maximum capacity. Production planning should retain at least 20% headroom below a capacity result measured from an external generator.
