# API and pressure testing

This directory has two deliberately separate test paths:

1. `api-test.mjs` checks the real dev site with one browser-equivalent session
   for each app role. It is low-volume and safe to run after every deployment.
2. `run.sh` creates an isolated EC2 clone and a separate load generator for a
   full pressure test. It runs only when an operator starts it locally.

Neither path runs on a pull request. Pull requests already run unit tests and a
production build; merging to `dev` should deploy that validated tree, not repeat
the same CI validation.

## GitHub Actions setup

Create three dedicated accounts on `https://dev.ai4talent.org`: one `STUDENT`,
one `TEACHER`, and one `ADMIN`. The teacher is the dedicated developer/test
account referred to as the “dev account.” Do not use a real course or personal
admin account. The teacher account must have completed any active teacher
consent gate.

Add these repository secrets under **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `DEV_TEST_STUDENT_LOGIN` | Dev test student's email or username |
| `DEV_TEST_STUDENT_PASSWORD` | Dev test student's password |
| `DEV_TEST_TEACHER_LOGIN` | Dev test teacher/developer email or username |
| `DEV_TEST_TEACHER_PASSWORD` | Dev test teacher/developer password |
| `DEV_TEST_ADMIN_LOGIN` | Dev test admin's email or username |
| `DEV_TEST_ADMIN_PASSWORD` | Dev test admin's password |
| `DEV_PRESSURE_RESULTS_TOKEN` | Ingestion token generated on dev |
| `PROD_PRESSURE_RESULTS_TOKEN` | Ingestion token generated on production |

## Ingestion tokens

Each deployment mints and stores its own tokens, so nothing has to be added to
the server's environment. Sign in as an admin on the site you want to publish
to, open `/admin/pressure-tests`, and use **Result ingestion tokens**:

1. On <https://dev.ai4talent.org/admin/pressure-tests>, generate a token
   labelled e.g. `GitHub Actions — dev` and copy it once. Save it as the
   `DEV_PRESSURE_RESULTS_TOKEN` GitHub secret.
2. Repeat on <https://ai4talent.org/admin/pressure-tests> and save that value as
   `PROD_PRESSURE_RESULTS_TOKEN`.

Only the SHA-256 digest is stored, so a token is displayed exactly once; if it
is lost, generate a replacement and revoke the old row. Revocation takes effect
on the next request — there is no redeploy and no `~/app/.env` edit.

The existing deployment secrets are still required: `EC2_HOST`, `EC2_USER`,
and `EC2_SSH_KEY`. GitHub supplies `GITHUB_TOKEN` automatically.

## The two API workflows

### Automatic critical check

`.github/workflows/deploy-dev.yml` builds and deploys a push to `dev`, waits for
the EC2 containers to become healthy, and then runs:

```bash
TEST_PROFILE=critical node pressure/api-test.mjs
```

It signs in all three accounts and checks the landing page, session creation,
profiles, student classes/notifications, teacher classes/quizzes, and the admin
stats, resources, and pressure-history endpoints. It does not create data.

### Manual full check

Open **Actions → Full Dev API Test → Run workflow**. The full profile:

- performs every critical check;
- creates a uniquely named topic, quiz, question, class, invitation, enrollment,
  assignment, and student quiz attempt through the normal APIs;
- deletes the temporary class, quiz, and topic in a `finally` cleanup;
- discovers every `src/app/api/**/route.ts` method and checks its read path or
  authorization/validation boundary, failing on missing handlers, 405s, or 5xx.

Potentially external/destructive functions such as sending SMTP tests, running
backups, restoring data, and calling hosted AI are checked at their authorization
boundary rather than executed. The successful fixture journey covers normal
state-changing API behavior without emailing users, writing S3 objects, or
leaving test records behind. Quiz submission is intentionally not completed:
`ExamResult` is an immutable archival record with no deletion API, so submitting
would violate the cleanup guarantee.

Both workflows save a JSON artifact and publish the same result to dev and prod.
Each deployment stores its own copy, so either admin dashboard remains available
if the other site is down.

## Historical dashboard

Sign in as an admin and open `/admin/pressure-tests`. The page includes:

- pass/fail and latency summary cards;
- a p95 latency trend;
- filters for time window, suite, scenario, status, and tested environment;
- paginated history with commit, source, virtual-user count, and failure detail;
- a **Result ingestion tokens** panel for generating and revoking credentials.

The ingestion endpoint is `POST /api/pressure-results`. It is public only at the
proxy layer and accepts a request only when its bearer token matches a live
token generated in that deployment's own admin UI. Browser history and token
management are separately protected by the normal admin session.

## Full isolated EC2 pressure test

The VM test clones the running production root volume with `--no-reboot`, boots
the copy as a private SUT, sanitizes it before Docker can start, and drives it
from a separate same-AZ load-generator instance. Production is not restarted or
modified.

The temporary encrypted volume still contains real student and consent records.
Sanitization removes AWS credentials, rotates `AUTH_SECRET`, disables SMTP,
backups, hosted AI, and public ingress, and verifies those controls. It does not
anonymize the data on the throwaway volume. Read `ec2/sanitize-sut.sh` before the
first run.

Setup:

```bash
cp pressure/.env.example pressure/.env
# Review the prefilled instance/key configuration, fill the result tokens,
# then explicitly set ACK_REAL_DATA=CLONE-PRODUCTION-DATA.
```

Run the default `exam-day` scenario:

```bash
./pressure/run.sh
```

Run the complete suite with one command (about three hours, including the
two-hour soak). It provisions and sanitizes once, publishes one result per
scenario, and always tears down at the end:

```bash
./pressure/run.sh all
./pressure/run.sh all --students 120
```

Or select a scenario and scale:

```bash
./pressure/run.sh smoke
./pressure/run.sh spike-recovery 1
./pressure/run.sh ramp-capacity 0.5
./pressure/run.sh soak 1
```

Or set an exact concurrent/peak student count instead of an abstract scale:

```bash
./pressure/run.sh exam-day --students 120
./pressure/run.sh ramp-capacity --students 500
./pressure/run.sh spike-recovery --students 800
./pressure/run.sh soak --students 100
```

`--students` means actively concurrent students, not total enrolled accounts.
It sets the exam-day cohort, the ramp/spike peak, or the constant soak load and
overrides `PRESSURE_SCALE` for that student workload. Provisioning mints enough
distinct sessions for the requested load and fails before k6 starts if the
production snapshot does not contain enough usable student identities. The
EC2-clone safety ceiling is 2,000 concurrent students.

### Scenario guide

| Scenario | Default shape | What it answers |
|---|---:|---|
| `smoke` | 1 journey, once | Does provisioning, sanitization, authentication, media, and collection work end to end? |
| `exam-day` | 120-student cohort + separate 120-student submit clump | Can a class work and submit together without lost grades or SQLite lock failures? |
| `ramp-capacity` | 30 → 75 → 150 → 225 → 300 students | Where is the throughput/latency knee? |
| `spike-recovery` | 20 → 400 → 20 students | Does the service recover after sudden overload without a lingering queue or restart? |
| `soak` | 40 students for 2 hours | Do memory, WAL, queue, or resource-dashboard costs drift over time? |
| `media-signing` | 8 students for 2 minutes | How much event-loop CPU does private-media URL signing consume? |
| `login-storm` | 10 login VUs for 2 minutes | What is password-hash latency and does the per-IP login throttle behave correctly? |
| `admin-observability` | 1 admin + 8 students for 3 minutes | How much collateral latency does the synchronous resources dashboard cause? |

The `smoke` shape is intentionally fixed. `login-storm` uses
`PRESSURE_LOGIN_VUS`, because its pressure unit is concurrent login attempts
rather than active students. `--students` applies to the other six scenarios.

### EC2 size recommendation

After collecting exact-count `exam-day` results on one or more SUT instance
types, ask the harness which measured type is proven for a target cohort:

```bash
./pressure/run.sh recommend-size --students 500
```

The command reads `pressure/.tmp/ec2-runs/**/result.json`, reports each type's
highest passing and lowest failing student count, and recommends the smallest
measured CPU/memory shape that passed at or above the target. It deliberately
does not extrapolate from CPU percentages or from a lower-count pass. If there
is not enough evidence, it prints the exact benchmark command to collect it:

```bash
./pressure/run.sh exam-day --students 500 --sut-type m7i.xlarge
```

The admin pressure-test dashboard shows the infrastructure run, SUT instance
type, vCPU/memory shape, and requested concurrent-student target for every new
result. A full-suite run appears as eight separately filterable scenario rows
linked by the same infrastructure-run identifier.

There is no `--dry-run` mode: every end-to-end scenario needs a temporary AMI.
Use `smoke` for the shortest provisioning and harness shakedown. AMI creation
waits up to `PRESSURE_AMI_WAIT_MINUTES` (60 by default), because the AWS CLI's
built-in waiter stops after 10 minutes even though initial EBS snapshots can
take substantially longer.

Prerequisites are AWS CLI credentials with EC2/AMI/EBS/security-group access,
`jq`, `ssh`, `scp`, Node 24, and access to the configured EC2 key. `run.sh`
uses the source instance's VPC, subnet, availability zone, and instance type
unless overridden in `.env`.

Artifacts are scrubbed on the load generator before download and written to
`pressure/.tmp/ec2-runs/<run>-<scenario>/`:

- `result.json` — normalized dashboard payload;
- `report.md` — human-readable tables;
- `summary.json` — k6 metrics;
- `probes.json` and `metrics.ndjson` — event-loop/resource samples;
- scrubbed container and k6 logs.

The result is then posted to both configured dashboards. An exit trap always
terminates both instances, deregisters the temporary AMI, deletes its backing
snapshots, and removes the temporary security groups. Each instance also has a
deadman shutdown. If a laptop dies mid-run, clean up all tagged resources with:

```bash
pressure/ec2/teardown.sh --all --region us-east-1
```

Start with `smoke` as a harness shakedown. Treat the first full run as SLO
calibration rather than a definitive capacity number.
