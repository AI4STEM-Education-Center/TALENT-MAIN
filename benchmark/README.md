# Benchmark & pressure-test harness

Load testing for the adaptive learning platform, modelled on how the system is
actually used rather than on which endpoint is easiest to hammer.

## Three tiers, three different questions

| Environment | Answers | Load |
| --- | --- | --- |
| **Local production Docker image** | Detect regressions and compare commits | Smoke plus 5–25 virtual users |
| **dev.ai4talent.org** | Validate Cloudflare, TLS, authentication, S3 redirects, browser experience | Low-volume only |
| **Isolated EC2 clone** | Determine real capacity, breaking point, recovery, queue behaviour | Full load, spike, stress, soak |

Each tier declares what it may conclude, in [k6/lib/config.js](k6/lib/config.js),
and the scenarios enforce it — `exam-day.js` refuses to run 60 VUs on the `local`
tier, `edge-validation.js` refuses to run anywhere but `dev`. Mixing them up is
the most likely way this harness could produce a confidently wrong answer.

```bash
benchmark/run-local.sh                                    # tier 1
benchmark/run-dev-site.sh --email … --password …          # tier 2
benchmark/ec2/provision.sh --source-instance i-0abc…      # tier 3
```

---

## What the design is reacting to

Four properties of this codebase determine what a benchmark has to measure. They
are why this harness looks the way it does.

**1. Every database query occupies the event loop.**
[src/lib/prisma.ts](../src/lib/prisma.ts) drives SQLite through
`better-sqlite3`, a *synchronous* binding. Prisma's adapter wraps it in promises,
but the query runs on the calling thread. There is one connection and no thread
offload, so request concurrency does not buy database parallelism — it converts
into event-loop queueing. **Event-loop delay is the leading indicator**, and it is
invisible from outside the process; HTTP latency alone tells you the system got
slow without telling you why. Hence [instrument/probe.cjs](instrument/probe.cjs).

**2. One process, one writer.**
No clustering. The in-memory rate limiter at
[src/lib/rate-limit.ts](../src/lib/rate-limit.ts) documents the single-instance
assumption. Quiz submit
([src/app/api/quiz/route.ts](../src/app/api/quiz/route.ts)) grades inside one
transaction holding SQLite's write lock across a claim, a `createMany` of every
answer row, and a progress upsert. Under a burst the failure mode is not graceful
degradation — it is the 5-second busy timeout surfacing as a 5xx, which is why
`sqlite_busy` gets its own counter.

**3. The worker contends with the web tier.**
[src/worker.ts](../src/worker.ts) runs ten concurrent loops against the same
database file on the same volume. A benchmark that ran the app without the worker
would report a capacity the real deployment cannot reach, so every tier runs both.

**4. Login is expensive and throttled.**
bcryptjs is pure JS at cost 12 — its async API yields between rounds, but it
still burns hundreds of milliseconds of single-core CPU per login, and each
attempt also writes a `SystemLog` row. Logins are capped at 10/min/IP. So
sessions are minted once up front, and login cost is measured deliberately by
its own scenario rather than incidentally by all of them.

---

## Layout

```
benchmark/
  run-local.sh              tier 1 — build, seed, run, compare, one command
  run-dev-site.sh           tier 2 — edge validation against the live dev site
  ec2/provision.sh          tier 3 — clone, run, collect, terminate
  ec2/teardown.sh           tag-filtered reaper for leaked resources
  seed/seed-bench.ts        deterministic, scale-factored dataset
  tools/mint-sessions.ts    pre-mints session cookies
  tools/install-k6.sh       pinned, checksum-verified k6
  mock-ai/server.ts         OpenAI-compatible stub, schema-driven responses
  instrument/probe.cjs      in-container event-loop + SQLite probe
  k6/lib/                   config, metrics, journeys
  k6/scenarios/             smoke, regression, edge-validation, exam-day,
                            ramp-capacity, spike-recovery, soak, login-storm
  playwright/               browser-level vitals (tier 2)
  collect/                  metrics sampling, summarise, compare
  baseline/                 committed reference runs for regression gating
  results/                  run artifacts (gitignored)
```

## Journeys, not endpoints

Every scenario composes the journeys in [k6/lib/journeys.js](k6/lib/journeys.js):
a student quiz session with per-question think time, a teacher watching stats, the
2-second polling floor an open admin tab generates, and a login storm.

The old suite blasted `/api/classes` with 50 connections. That measures the
ceiling of one query. It cannot tell you whether a class of thirty can sit an exam,
because it never produces the shape that actually hurts: a burst of quiz starts, a
long quiet stretch, then a clump of submissions all contending for one write lock
while teachers poll stats and the worker drains AI jobs against the same file.

Two details that matter more than they look:

- **One distinct user per VU.** Sharing an account collapses every write onto one
  row — hiding the contention this exists to find — and trips the pending-attempt
  resume path, so the second VU silently reuses the first's attempt.
- **VUs guess their answers.** Quiz start strips `isCorrect` and `answerNumeric`,
  so a VU answers like a student does. That also keeps the worker loaded: a
  perfect attempt skips recommendation generation entirely.

## The dataset is not optional

A run against a freshly seeded database measures almost nothing, because the
endpoints that decay with volume are the aggregation ones
([quiz-stats-server.ts](../src/lib/quiz-stats-server.ts), grades-export, admin
stats). [seed/seed-bench.ts](seed/seed-bench.ts) builds a term of history —
default 360 students, 20 quizzes × 25 questions, ~14k attempts, ~360k answer rows
— deterministically, so run N and run N+1 compare the same data.

Row ids are derived from counters rather than `cuid()`, at cuid's 25-character
width so index fan-out stays realistic. Reruns are byte-identical, which is what
lets tier 3 ship one golden `bench.db` and know every run started from the same
page layout.

Scale it with `BENCH_SCALE` (`0.25` for CI, `2` for a big cohort). The seed
**refuses to run** unless the target filename contains `bench`.

## AI calls are stubbed

Every use case is assigned to [mock-ai/server.ts](mock-ai/server.ts), which
streams OpenAI-compatible chat completions with configurable TTFT and token delay.
Real inference would make runs non-reproducible, cost money, and mostly measure
someone else's queue.

The stub reads the `response_format` json_schema the app sends and generates a
conforming object, so it stays correct as those prompts evolve rather than
hardcoding five response shapes.

---

## Tier 1 — local production Docker image

```bash
benchmark/run-local.sh                       # regression run + baseline diff
benchmark/run-local.sh --scenario smoke      # wiring check, ~1 minute
benchmark/run-local.sh --update-baseline     # promote a passing run
```

Requires Docker and k6 (`brew install k6`). Everything else — secrets, dataset,
sessions, the mock AI bundle — is generated on first run.

Runs the same `docker/Dockerfile` production deploys use, on ports 3100/3101 with
its own volume, so it can coexist with `npm run dev`. Measuring `next dev` would
measure on-demand compilation instead of the app.

**This tier compares commits. It does not measure capacity** — a dev machine has
more cores than the EC2 host and an NVMe fsync profile EBS cannot match.
[collect/compare.ts](collect/compare.ts) refuses to compare across tiers for
exactly this reason, and requires a regression to clear both 20% *and* 25ms with
at least 30 samples before calling it one.

CI runs this on PRs that touch `src/`, the schema, `docker/`, or `benchmark/`, and
posts a rolling comparison comment.

## Tier 2 — dev.ai4talent.org

```bash
benchmark/run-dev-site.sh --email you@uga.edu --password …
```

Validates TLS version, Cloudflare proxying (`cf-ray`), HTTP/2+, HSTS,
compression, that a `__Secure-` session cookie survives the tunnel, that
presigned S3 URLs are fetched directly from S3, and — via
[playwright/browser-journey.mjs](playwright/browser-journey.mjs) — real LCP/CLS
and click-to-first-question in Chromium. k6 is blind to hydration cost, and this
app renders 41 dashboard pages server-side before hydrating React on top.

Capped at 3 VUs and 6 journeys/minute, for structural reasons:

- dev and prod share one EC2 host, so load here degrades production **and**
  imports production's noise into the measurement
- Cloudflare's WAF starts answering 403 to sustained synthetic traffic, silently
  invalidating a run
- the dev database holds real data

The script refuses any URL that does not look like dev/staging. Never point a load
tool at production.

## Tier 3 — isolated EC2 clone

```bash
benchmark/ec2/provision.sh --source-instance i-0abc123 --scenario exam-day
benchmark/ec2/provision.sh --source-name talent-prod --scenario soak --dry-run
```

One command does all of it: read the production instance's own configuration
(type, AMI, subnet, IAM profile, root-volume type/size/IOPS/throughput), create a
throwaway keypair and security group scoped to your IP, launch the clone plus a
separate load generator in the same AZ, ship the pre-seeded golden database, run
the scenario while sampling three layers of metrics, copy everything back, and
terminate every resource it created.

**Production is never touched.** Nothing is created in prod's security group; the
clone boots from prod's AMI onto a fresh volume with a fresh database and freshly
generated secrets.

Three independent guarantees against leaked instances, because that is the
expensive failure:

1. `provision.sh` tears down in an `EXIT` trap, so a failure between any two
   steps still cleans up.
2. Both instances arm `shutdown -h +180` as their *first* action, with
   `instance-initiated-shutdown-behavior=terminate`. A killed orchestrator cannot
   leave them billing.
3. `teardown.sh --all` reaps anything tagged `Purpose=alw-benchmark`, and the tag
   filter means it can never touch production.

The load generator is a separate instance deliberately: the app is bottlenecked on
a single CPU running synchronous SQLite queries, and running k6 beside it would
have the measurement tool competing for the resource under measurement.

### Scenarios

| Scenario | What it establishes |
| --- | --- |
| `exam-day` | The realistic worst case: 60 students arriving over 2 minutes, then submitting in a clump |
| `ramp-capacity` | Steps concurrency until an SLO breaks. That step is the capacity number |
| `spike-recovery` | Whether the system comes back after a burst, measured as `recovery_seconds` |
| `soak` | 90 minutes — WAL growth, queue drift, leaks, and EBS/CPU credit exhaustion |
| `login-storm` | bcrypt cost under concurrency (`cost` mode) and that the limiter protects the server (`limiter` mode) |

Report capacity as **"N concurrent students at p95 < X"**, not peak RPS. With
think time in the model, a higher RPS just means shorter journeys.

### Burstable instances

If the source is `t2`/`t3`/`t3a`/`t4g`, `provision.sh` says so, and the warning
is worth acting on: CPU credits and gp2/gp3 burst IOPS drain under sustained
load. A 10-minute run looks excellent and a 40-minute one falls off a cliff. Run
`--scenario soak` before trusting any capacity number from such a host;
[collect/metrics.sh](collect/metrics.sh) records the `CPUCreditBalance` series
that shows it happening.

### CI

`.github/workflows/benchmark.yml` → *Run workflow* → tier `ec2`. Needs
`BENCH_AWS_ROLE_ARN` (OIDC, no long-lived keys) and `AWS_REGION`. The reaper runs
`if: always()`.

---

## Reading a result

`summary.md` per run: per-step percentiles, the error taxonomy, worker drain, and
process internals.

**Errors are split, not summed.** Four common non-200s are *correct* behaviour —
429 (login throttle), 409 (duplicate submit rejected), 403 (attempt cap or
availability window), 410 (quiz deleted mid-attempt). Summing them with 5xx means
a run either looks broken when it is fine, or looks fine while submissions are
being lost to a lock timeout. So `designed_responses` is reported separately and
only `unexpected_errors` can fail a run.

Numbers to look at first:

- **`sqlite_busy` — must be zero.** Anything else means graded submissions were at
  risk of being lost.
- **Event-loop p99.** Rises before HTTP latency does; the earliest honest warning.
- **WAL growth over a soak.** Monotonic growth means checkpoints are being starved.
- **Final vs peak queue depth.** A final depth near the peak means the worker never
  caught up and students never saw their summaries.

## Initial SLOs

In [k6/lib/config.js](k6/lib/config.js) per tier. Tier 3:

| Step | Target |
| --- | --- |
| `POST /api/quiz` (start) | p95 < 800ms |
| `PATCH /api/quiz` (submit) | p95 < 1200ms, zero 5xx, zero SQLITE_BUSY |
| Dashboard SSR TTFB | p95 < 600ms |
| Stats / grades-export | p95 < 2500ms |
| Unexpected error rate | < 0.1% |
| Spike recovery | < 180s |

These are v1 estimates to be recalibrated after the first clone run, not
measurements.

## No application code was changed

The probe is loaded with `NODE_OPTIONS=--require` from a bind-mounted file. No
`/api/...` endpoint was added, so nothing here ships in the production image or
widens its attack surface. The trade-off is that the probe only exists while a
benchmark compose file is running — which is the correct scope for it.
