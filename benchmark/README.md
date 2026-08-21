# Pressure-test harness

A load and pressure-test suite built around how *this* system actually breaks,
replacing the retired `aiohttp` endpoint blaster.

Three tiers, three questions. Each tier is **enforced**, not just documented —
mixing them up is the most likely way a harness produces a confidently wrong
answer, so the scenarios refuse to run on the wrong one.

| Tier | Answers | Load | Command |
|---|---|---|---|
| **local** — the production Docker image | Did this commit make anything slower? | smoke → 25 VUs | `run-local.sh` |
| **dev-site** — dev.ai4talent.org | Does the real edge path work? Cloudflare, TLS, cookies, signed media | 1 VU, 1 iteration | `run-dev-site.sh` |
| **ec2-clone** — an isolated clone of production | What is the real capacity, breaking point and recovery? | full load, spike, soak | `ec2/provision.sh` → `run-ec2.sh` |

---

## What this design reacts to

Not generic load-testing advice. Six properties of *this* codebase, each of which
changes what is worth measuring:

1. **Every query occupies the event loop.** `src/lib/prisma.ts` drives SQLite
   through `better-sqlite3`, a **synchronous** binding. Request concurrency
   becomes event-loop *queueing*, not database parallelism — so event-loop delay
   is the leading indicator, and it is invisible from outside the process.
   That is what `instrument/probe.cjs` exists for.

2. **One process, one writer.** Quiz submit grades inside a transaction that
   holds SQLite's single write lock (`src/app/api/quiz/route.ts` `PATCH`). A
   cohort submitting together is a *queue*, not parallel work, and past a certain
   depth the tail exceeds the adapter's `timeout: 5000` — at which point a graded
   submission is **lost**, not merely slow. `sqlite_busy` gets its own counter
   and any non-zero value fails a run.

3. **Private media signing is RSA, per URL.** Commit `af6fe35` moved reads from
   S3 presigning (HMAC, microseconds) to **CloudFront signed URLs** (RSA-SHA1,
   ~1ms of CPU on the event loop). `POST /api/quiz` signs one URL per question
   figure **and** per image answer choice, so a 10-question quiz with 4 image
   options each is **50 RSA operations for one quiz start**. `Promise.all` does
   not parallelise CPU. Cost scales with *(figures + image options)*, not
   question count — and is invisible in any dataset whose questions have no
   media, which is why the seed builds a media-heavy quiz on purpose.

4. **The admin dashboard is a load source.** `GET /api/admin/resources` calls
   `readSpool()` (`src/lib/resource-spool.ts`), which is **synchronous**:
   `readFileSync` plus a full line-parse of every node's NDJSON file, on the main
   thread, with the time filter applied *after* parsing. Four nodes × one sample
   a minute × seven days ≈ **40,000 lines parsed per request**, and every
   millisecond of it delays every other in-flight request. One admin with a tab
   open is enough to matter — see `scenarios/admin-observability.js`.

5. **The worker contends with the web tier.** `src/worker.ts` runs **fifteen**
   concurrent loops against the same database file. The Honker queue lives in a
   *separate* SQLite file, but every `enqueue*()` call opens a **fresh** handle
   (`src/lib/queue.ts`), so a submit burst is also a burst of file opens. Every
   tier therefore runs both services; omitting the worker reports a capacity the
   real deployment cannot reach.

6. **bcryptjs cost 12 is the most expensive operation in the app** — and
   `bcryptjs` is **pure JS**, so unlike native bcrypt it never yields the event
   loop while stretching. One login blocks everyone. Logins are also capped at
   10/min/IP. Sessions are therefore pre-minted, and login cost is measured in
   isolation by `login-storm.js`.

Also worth knowing while reading any report: **prod and dev share one EC2
instance, one disk and one 20 GB root volume**, with **no CPU or memory limits**
on any of the four containers (`docker/docker-compose.yml`).

---

## Journeys, not endpoints

The retired suite blasted one endpoint with one shared login session, which gets
it wrong twice: it never produces the request *mix* a real cohort produces, and
one session collapses every write onto one row.

Scenarios compose real sequences instead — open the class, start a quiz, answer
with per-question think time, submit, read results — with a teacher watching
stats and an admin polling the dashboard alongside.

Two details that matter more than they look:

- **Every VU takes a distinct identity.** Sharing one student would hit the
  pending-attempt resume path in `POST /api/quiz` (which reuses an existing
  unfinished attempt), so every VU after the first would measure a *resume*
  rather than a quiz start.
- **VUs guess their answers.** They cannot do otherwise — quiz start strips the
  grading data (`omit` on the numeric answer, options selected without
  `isCorrect`). It also keeps the worker loaded: recommendation generation keys
  off missed questions, so a perfect cohort leaves the worker idle.

## Errors are classified, not summed

`401/403/409/410/429` are this app's **designed** responses: attempt cap,
duplicate submit rejected, quiz deleted mid-attempt, login throttle. Summing them
with 5xx yields one of two wrong answers — the run looks broken when it is fine,
or looks fine while submissions are being lost. Only `unexpected_errors` and
`sqlite_busy` can fail a run.

---

## Tier 1 — local

```bash
cp benchmark/docker/bench.env.example benchmark/docker/bench.env
benchmark/tools/install-k6.sh

benchmark/run-local.sh --scenario smoke          # prove the plumbing
benchmark/run-local.sh --scenario regression --label before
#   ... make a change ...
benchmark/run-local.sh --scenario regression --label after --compare before
```

Runs the **real production image** plus the worker plus the AI stub, seeds a
deterministic synthetic dataset, mints sessions, runs k6, and writes a report.

Absolute numbers here are **not** capacity numbers — the container's CPU share is
usually the limit, not the app. Deltas between two local runs are the product,
which is why `regression.js` pins its VUs, duration and think time as literals:
changing them invalidates every stored baseline.

### Measuring the CloudFront signing cost

```bash
benchmark/run-local.sh --compare-signing
```

Runs `media-signing` twice against the same image and the same dataset — once
with `CLOUDFRONT_*` populated, once with them cleared (the documented rollback
switch) — and prints the delta. **That delta is the per-URL RSA cost.**

## Tier 2 — dev.ai4talent.org

```bash
AUTH_SECRET=<dev secret> npx tsx benchmark/tools/mint-sessions.ts \
  --out dev-sessions.json --database-url file:/path/to/dev.db \
  --students 3 --teachers 1 --admins 1 --secure

benchmark/run-dev-site.sh --session-file dev-sessions.json
```

**Correctness only, never capacity.** One VU, one iteration. dev shares an
instance, a disk, a Caddy and a Cloudflare zone with production, so load here
degrades the live site — and Cloudflare's WAF would throttle a load generator
anyway, meaning you would measure the WAF.

It asserts what *cannot* be reproduced locally: the edge resolves end to end,
`X-Robots-Tag: noindex` is present, host validation rejects an unknown `Host`,
the Origin/CSRF check rejects a cross-site mutation, and — the important one — an
**unsigned** CloudFront URL returns **403**, which is what proves the trusted key
group is actually attached and the bucket is not world-readable
(`docs/SETUP.md` §7.7).

## Tier 3 — isolated EC2 clone

```bash
benchmark/ec2/provision.sh --source-instance i-0abc123 --ack-real-data --region us-east-1
benchmark/run-ec2.sh --run-id bench-20260820-193000 --scenario exam-day --cohort 200
benchmark/ec2/teardown.sh --run-id bench-20260820-193000 --region us-east-1
```

`provision.sh` reads the source instance's **own** configuration (type, AZ,
subnet, VPC, key pair, root device) rather than taking it from flags — hard-coding
an instance type is how a benchmark ends up measuring a machine nobody runs,
while looking authoritative.

It then creates an AMI from production's running root volume with `--no-reboot`,
boots a clone onto a **fresh encrypted volume** from that snapshot, and launches a
**separate load generator** in the same AZ. Separate on purpose: k6 on the system
under test would compete for the single CPU the app is bottlenecked on.

**Production is never modified.** `--no-reboot` means it is not restarted;
nothing is added to its security groups; its volume is never attached anywhere.

### ⚠️ The clone holds real production data

This is a deliberate, informed tradeoff — real row counts and real index depths
are what make tier-3 capacity numbers trustworthy — and it is the riskiest thing
in this directory. **Read `ec2/sanitize-sut.sh` before your first run.**

Left alone, a booted clone would, with no load test even running:

1. **Delete real production S3 objects.** The worker's GC deletes every object
   under `S3_KEY_PREFIX` with no database reference. The inherited config pins
   that to `prod/` — production's own namespace — and the clone's database
   diverges the moment a load test touches it.
2. Email real students and teachers (SMTP is enabled, with working credentials).
3. Write to the real WebDAV backup target and rotate real backups out.
4. Send real student answers to a hosted AI provider, on the real API key.
5. Serve on production's hostnames, with a real Cloudflare DNS token.

`sanitize-sut.sh` runs **before the application is allowed to start** and is
fail-closed by construction:

- Docker is **stopped and masked** in cloud-init `bootcmd` — before
  `multi-user.target`, so the `restart: unless-stopped` production containers
  never start — and is unmasked *only* by `ec2/bootstrap-sut.sh`, which refuses
  unless sanitize wrote its success marker.
- The clone therefore boots with the application **not running at all**.
  `provision.sh` gets it to that safe state; `run-ec2.sh` is what ships the
  sanitize payload over SSH and starts things. A clone that is provisioned and
  then forgotten never runs the app, and the deadman timer terminates it.
  (The payload travels over SSH rather than in cloud-init because EC2 caps
  user-data at 16 KB and embedding it came to ~47 KB — ~19 KB even gzipped.)
- AWS credentials are **removed**, not repointed. `getAwsCredentials()` throws
  when they are absent, so the GC and every S3 write fail loudly. Chosen over a
  `bench/` prefix because a prefix is a behavioural guard one stale config can
  defeat; absent credentials cannot be.
- CloudFront signing keys are **kept** — signing is local RSA, grants no write
  access, and is one of the main things this tier measures.
- `AUTH_SECRET` is **rotated**, so production cookies are useless on the clone
  and the clone's minted cookies are useless against production.
- SMTP, scheduled backups and hosted AI providers are disabled **in the
  database** (they are admin-UI rows, not env vars), and every control is **read
  back** — an `UPDATE` on an empty table reports success while changing nothing.
- The database is WAL-checkpointed and `integrity_check`ed, because a
  `--no-reboot` snapshot is crash-consistent.
- The whole edge stack is renamed out of the way.

Artifacts are **scrubbed on the load generator before download**
(`collect/scrub.ts`): emails and signed-URL credentials are redacted, and the
session bundle — a pile of live cookies — is dropped outright.

**Residual risk, stated plainly:** real student and IRB consent data exist on the
clone's volume for the life of the run. Sanitizing removes the ability to *act*
on it; it does **not** anonymize it. Name-shaped strings in free text are not
redactable by pattern and may survive scrubbing. If you want realistic row counts
without real records, see below.

### Tier 3 with synthetic data instead

If faithful row counts matter more to you than faithful *records*, provision as
above and then replace the database before the run:

```bash
# on the clone, with the app stopped
npx tsx benchmark/seed/seed-bench.ts --database-url file:/path/to/bench.db --scale 10
```

You lose production's exact data distribution; you keep its hardware, its image
and its configuration, and no real records leave the account.

### Three guards against leaked instances

A leaked instance is the expensive failure, and closing a laptop mid-run is the
likely cause:

1. An `EXIT` trap in `provision.sh` tears down a failed provision.
2. `shutdown -h +300` armed in `bootcmd` as each instance's **first** action,
   paired with `--instance-initiated-shutdown-behavior terminate`.
3. `teardown.sh --all`, filtered on the `Purpose=alw-benchmark` tag.

`teardown.sh` deletes the AMI's **backing snapshots** too. Deregistering an AMI
does not, and a production root-volume snapshot bills monthly, forever.

---

## Scenarios

| Scenario | Tiers | What it is for |
|---|---|---|
| `smoke` | local, ec2 | One of everything, once. Run this first. |
| `regression` | local | Pinned VUs/duration/think time for commit-to-commit deltas. |
| `media-signing` | local, ec2 | Isolates the CloudFront RSA-per-URL cost. |
| `admin-observability` | local, ec2 | The synchronous spool parse, and its **collateral** cost to unrelated traffic. |
| `login-storm` | local, ec2 | bcrypt cost 12 under concurrency, and the throttle's correctness. |
| `exam-day` | ec2 | A cohort arriving over 2 min, then a **submit clump**. The shape that serialises on the write lock. |
| `ramp-capacity` | ec2 | Steps upward to find the knee. Expected to breach SLOs — read the report, not the exit code. |
| `spike-recovery` | ec2 | Does it come **back**? Compare the quiet phase before with the quiet phase after. |
| `soak` | ec2 | Hours. Rate-limiter map growth, WAL growth, and admin-latency **drift** as the spool grows. |
| `edge-validation` | dev-site | Config assertions that only the real edge can answer. |

## The host allowlist will bite you

`src/proxy.ts` validates the host on **every** request against a fixed allowlist
(`ai4talent.org`, `*.ai4talent.org`, `localhost`, `localhost:3000`) and returns a
bare **403** for anything else — before any route runs.

The local tier publishes on 3100 so a benchmark never collides with `next dev`,
so `127.0.0.1:3100` is *not* on that list. The runners therefore send
`X-Forwarded-Host: localhost:3000`, which is exactly what production's Caddy
sends and which `src/proxy.ts` prefers over `Host`. Faithful, not a workaround.

Why this is called out so prominently: without it **every request is refused**,
and because 403 is a legitimately *designed* status for this app (CSRF origin
mismatch, consent gate, attempt cap), the taxonomy counted all of it as correct
behaviour and the run reported a clean **PASS having exercised nothing**. The
first CI run of this harness did exactly that. Three things now make it
impossible to miss:

- `smoke` and `regression` assert their steps actually ran (`requireSteps`), so
  a journey that stops early fails instead of reporting 0.0ms rows.
- The first designed refusal per step+status is logged, with this as the prime
  suspect.
- The report flags any run where refusals dominate the request count.

If you target the app on a different host or port, set `BENCH_FORWARDED_HOST` to
something the allowlist accepts.

## Signed media is verified, not always fetched

Two halves to the CloudFront change, verifiable on different tiers:

- **Always:** the harness counts every media URL the app produced and asserts it
  actually carries a signature (`Key-Pair-Id`/`Signature`, or `X-Amz-Signature`
  on the S3 path). `media_unsigned` must be **0** — a URL with no signature means
  the browser was handed unauthenticated access to a private object. This half
  needs no network.
- **`ec2-clone` / `dev-site` only:** a bounded sample is actually fetched, because
  there the distribution and objects are real, so a 403 means the trusted key
  group is misattached and a 404 means the object is missing.

`smoke` and `media-signing` **pin** the media-heavy quiz (recorded in the seed
manifest and passed as `BENCH_MEDIA_TARGET`), because only one quiz per class
carries figures and image options — random discovery finds it about a quarter of
the time, which made smoke's coverage of the signing path a coin flip. On
`ec2-clone` there is no synthetic manifest, so those scenarios fall back to
random discovery against production's real content; check the Signed media
section of the report to see whether that run actually exercised signing.

On **`local`** the distribution is necessarily a throwaway — you cannot stand up
a real private distribution in CI and the seeded objects exist in no bucket — so
fetching would contribute one DNS failure per URL and say nothing about the app.
Signing cost and signature validity are both fully exercised without it. Override
with `BENCH_FETCH_MEDIA=1` if your local run does have a real CDN.

## Reading a report

Correctness first, latency second:

- **`sqlite_busy` must be 0.** Non-zero means a graded submission was *lost*.
- **`unexpected_errors` must be 0.** Designed refusals are counted separately.
- **Event-loop delay** is the attribution tool. Bad latency *with* a healthy loop
  means the bottleneck is not the app. `exceeds > 0` means the loop was blocked
  longer than the histogram could record, so the percentiles **understate** it.
- **Threshold polarity:** in k6's export, a threshold boolean means *"was this
  crossed?"* — `true` is a **failure**. `summarize.ts` handles both shapes and
  reports anything it cannot interpret as unknown rather than assuming it passed.
- **A step with count 0 ran zero times.** Latency thresholds pass trivially on an
  empty step, which is why the deterministic scenarios assert their steps ran.
- **Refusals dominating the request count** means suspect the harness, not the
  app — see the section above.

## Calibration

The SLO numbers in `config/tiers.json` are **v1 estimates derived from the
architecture**, not measurements. Recalibrate them from the first real clone run:
take the observed p95, add headroom, and record the instance type alongside them.
Until then, treat a threshold breach as "look at this", not as a fact about
production.

## Layout

```
config/tiers.json     tier definitions + SLOs — the single source of truth
k6/lib/               config (tier guards, sessions), metrics (taxonomy), journeys
k6/scenarios/         one file per question being asked
seed/seed-bench.ts    deterministic synthetic dataset, media-heavy on purpose
tools/mint-sessions   forge Auth.js JWT cookies (never log VUs in)
tools/install-k6.sh   pinned + checksum-verified; shared by CI and the loadgen
instrument/probe.cjs  event-loop delay, via --require (no production surface)
mock-ai/server.ts     OpenAI-compatible stub that conforms to the sent json_schema
docker/               tier-1 stack: production image + worker + AI stub
ec2/                  provision / sanitize / teardown, plus the SUT compose file
collect/              metrics sampling, report, regression compare, PII scrub
```

## Known limitations

- **Tier 1 is exercised on every pull request** and passes end to end: the
  production image builds, the stack comes up, the dataset seeds, sessions mint,
  and the full student + teacher + admin journey runs with 0 unexpected errors
  and 10 signed media URLs. It has *not* been run on a developer workstation with
  Docker Desktop, so macOS-specific wrinkles are unproven.
- **Tier 3 has never been run.** It needs a real production instance id and AWS
  credentials. Treat the first run as a shakedown of the harness, not as a
  capacity measurement.
- **The smoke numbers are not capacity numbers.** A GitHub runner with one VU
  says the plumbing works; nothing more. `p95 ≈ 100ms` there implies nothing
  about a cohort on the real box.
- **`login-storm` cannot measure hash throughput** from a single generator: the
  10/min/IP throttle caps it at ten real hashes a minute. It measures hash
  *latency* under concurrency and the throttle's correctness. Real throughput
  needs many source IPs.
- **The scrubber cannot redact names.** Emails, tokens and signed-URL credentials
  are pattern-matchable; a student's name in free text is not.
- **Uploads 500 on a tier-3 clone**, because AWS credentials are stripped. No
  scenario exercises them, and the taxonomy records those as unexpected errors so
  it can never pass unnoticed.
- **The AI stub satisfies the JSON schema but not app-level semantic validators.**
  Where a validator rejects a stub payload (for example a simulation plan), that
  job is marked FAILED — which still exercises the worker's error path, but is not
  the same as a successful generation.
