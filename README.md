# Adaptive Learning Platform

A Next.js 14 adaptive learning platform for science education with teacher dashboards, class management, and module-based quizzes.

## Tech Stack

- **Next.js 14** (App Router) + TypeScript
- **Prisma ORM** — SQLite (configured with WAL mode and `busy_timeout` optimizations)
- **NextAuth.js v5** — credentials-based login (email or username)
- **Tailwind CSS** + shadcn/ui components
- **Docker & Docker Compose** — containerized deployments for both web and background worker services
- **Honker Node** — high-concurrency background worker tasks

## Development

```bash
npm install
cp .env.example .env
npm run setup            # creates DB, seeds questions + demo teacher
npm run dev              # starts dev server
```

Open [http://localhost:3000](http://localhost:3000).

Demo teacher account: `edwardcheng@uga.edu` / `nY*H1#6i#t8kqeP`

Run `npm run setup` again at any time to wipe and re-seed a clean database.

## Production

Production deployment is fully containerized using **Docker** and **Docker Compose** on an **AWS EC2** instance.

The production architecture consists of two services:
1. **web**: The Next.js 14 web application.
2. **worker**: A background worker powered by `honker-node` to run tasks asynchronously without blocking the Next.js API.

### Server Setup (EC2 Host)

An automated setup script is provided at [scripts/ec2-setup.sh](file:///home/edward/data/adaptive_learning_webapp/scripts/ec2-setup.sh). Run this script on a fresh Debian/Ubuntu EC2 instance (as the `admin` user) to:
1. Install Docker and add your user to the `docker` group.
2. Create app directories (`~/app/data/db/prod` and `~/app/data/db/dev`).
3. Set permissive directory permissions (`777` for SQLite DB folders, `666` for database files) so the nextjs container user can write to them.
4. Auto-generate the production `docker-compose.yml` and `docker-compose.dev.yml` files in `~/app`.
5. Pre-configure a template `~/app/.env` file.
6. Generate SSH deployment keys (`~/.ssh/github_actions`) for GitHub Actions automation.
7. Configure `rclone` and schedule a cron job for daily OneDrive backup of the SQLite production database (`~/app/scripts/sqlite_backup.sh`).

### Deployment via GitHub Actions

Our CI/CD pipeline in [.github/workflows/deploy.yml](file:///home/edward/data/adaptive_learning_webapp/.github/workflows/deploy.yml) (on `master` branch) and [.github/workflows/deploy-dev.yml](file:///home/edward/data/adaptive_learning_webapp/.github/workflows/deploy-dev.yml) (on `dev` branch) automates deployment:
1. Builds the Docker image based on [docker/Dockerfile](file:///home/edward/data/adaptive_learning_webapp/docker/Dockerfile) (injecting release version/date from `version.json`).
2. Pushes the image to **GitHub Container Registry (GHCR)**.
3. SCPs the docker-compose file to the EC2 server (`~/app`).
4. SSHes to the EC2 instance, pulls the latest image, and restarts the containers:
   ```bash
   docker compose up -d --force-recreate --no-build
   ```
5. Prunes stopped containers and images nothing is running any more (anything older than a week and not in use by a live container). The instance has a 20 GB root volume shared by both stacks, so superseded images are not free to keep.

### Disk on the instance

The admin **System Resources** tab shows how full the root volume is and how much of it is the application's own data. It cannot show the rest: the app containers run as an unprivileged user and `/var/lib/docker` is not readable from inside them. When the tab says the disk is filling up and the database volumes do not explain it, SSH to the instance and work down this list — each command is read-only.

```bash
# 1. Which filesystem, and how much is actually gone
df -h /

# 2. Which top-level directory holds it (-x stays on the root volume).
#    Note that the children never sum to the total: large files sitting
#    directly in / — /swapfile above all — are in the total but get no line.
sudo du -h --max-depth=1 -x / | sort -rh | head -15
ls -lh /swapfile 2>/dev/null

# 2b. Drill into whichever directory won. /home is a frequent surprise:
#     package-manager caches (~/.cache/uv, ~/.cache/pip, ~/.npm) and toolchain
#     installs (~/.nvm) belong to nobody in particular and are never cleaned.
sudo du -h --max-depth=2 -x /home | sort -rh | head -15

# 3. Docker's own accounting: images, containers, volumes, build cache.
docker system df
docker system df -v | head -40

# 3b. Volumes with LINKS 0 are orphans from containers that no longer exist.
#     They are invisible to image and container pruning.
docker volume ls -f dangling=true

# 4. Container logs. Unbounded before the max-size limits were added, so
#    anything created before that deploy is still whatever size it grew to.
#    The glob has to be expanded BY root inside sh -c: /var/lib/docker is
#    mode 0710 root:root, so your own shell cannot expand it and silently
#    hands du a literal path that does not exist.
sudo sh -c 'du -ch /var/lib/docker/containers/*/*-json.log | sort -rh | head'

# 5. Everything else that grows quietly on a long-lived Ubuntu box
journalctl --disk-usage
sudo du -sh /var/log /var/cache/apt /snap /boot /usr/lib/modules 2>/dev/null
ls -1 /boot/vmlinuz-* | wc -l   # old kernels, if apt autoremove has not run

# 6. Our data, for comparison — expect this to be small
du -sh ~/app/data/*

# 7. Anything else over 100 MiB
sudo find / -xdev -type f -size +100M -exec ls -lh {} + 2>/dev/null | sort -k5 -rh | head -20
```

Cleanup, once you know what is large. Run only what the numbers above justify:

```bash
docker container prune -f                          # stopped containers
docker image prune -af --filter "until=168h"       # images nothing is running
docker builder prune -f                            # build cache
docker volume prune -f                             # ANONYMOUS volumes only

# Truncate oversized container logs in place. Safe while running — the daemon
# holds the fd and keeps appending — but it discards history.
sudo sh -c 'truncate -s 0 /var/lib/docker/containers/*/*-json.log'

sudo journalctl --vacuum-size=200M                 # journald defaults to 10% of the FS
sudo apt-get autoremove --purge -y && sudo apt-get clean
```

Avoid `docker system prune -a --volumes`: it also deletes unused volumes, which includes `talent-resource-metrics` whenever both stacks happen to be down.

Going forward, both compose stacks cap their container logs (`json-file`, 10 MiB × 3 per container, so ≤120 MiB total) and both deploy workflows prune stopped containers and unused images rather than only dangling ones.

## GitHub Deployment Secrets

The GitHub Actions workflow currently needs these repository secrets:

| Secret | Description |
|---|---|
| `EC2_HOST` | Public host/IP of the deployment server |
| `EC2_USER` | SSH username used for deploys |
| `EC2_SSH_KEY` | Private SSH key for that server |

`GITHUB_TOKEN` is used by the workflow too, but GitHub provides that automatically, so you do not need to create it manually.

## Server `.env` For Docker Deploys

The database URL and worker environment are no longer read from GitHub Actions secrets during the image build.
Instead, Docker Compose expects them on the EC2 server in `~/app/.env`, next to `~/app/docker-compose.yml`.

Example `~/app/.env`:

```bash
# --- Database ---
# SQLite is used. The volume is mounted to /app/prisma/data in the container
PROD_DATABASE_URL="file:./data/prod.db"
DEV_DATABASE_URL="file:./data/dev.db"

# --- Authentication & Registration Security ---
AUTH_SECRET="your-generated-nextauth-secret-here"
TEACHER_SIGNUP_TOKEN="your-secret-teacher-code"
ADMIN_SIGNUP_TOKEN="your-secret-admin-code"

# --- Encryption Key for AI Provider Credentials ---
# Used to encrypt API keys stored securely in the database.
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
API_KEY_ENCRYPTION_SECRET="your-hex-32-byte-secret"

# --- AWS credentials (required; no IAM instance role) ---
AWS_ACCESS_KEY_ID="your-access-key-id"
AWS_SECRET_ACCESS_KEY="your-secret-access-key"

# --- AWS S3 (Learning Materials) ---
AWS_REGION="us-east-1"
AWS_S3_BUCKET="your-bucket-name"
LEARNING_MATERIAL_MAX_BYTES="52428800"

# --- CloudFront (image + PDF delivery) ---
# Leave all three empty to serve reads from S3 with presigned URLs instead.
CLOUDFRONT_DOMAIN="d111111abcdef8.cloudfront.net"
CLOUDFRONT_KEY_PAIR_ID="K2JCJMDEHXQW5F"
# base64 -w0 private_key.pem
CLOUDFRONT_PRIVATE_KEY="LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLQo..."
```

## Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | SQLite connection string used by Prisma for local development (e.g., `file:./data/dev.db`) |
| `PROD_DATABASE_URL` | Production SQLite connection string read by Docker Compose (maps to `DATABASE_URL` in production container) |
| `DEV_DATABASE_URL` | Dev SQLite connection string read by Docker Compose (maps to `DATABASE_URL` in dev container) |
| `DB_PROVIDER` | Set to `sqlite` to run WAL mode optimizations on startup |
| `APP_URL` | Public base URL of the deployment (e.g. `https://dev.ai4talent.org`). New-message notification emails use it to link students straight to the message; without it (or `AUTH_URL` / `NEXTAUTH_URL`) those emails fall back to "sign in and open Notifications" |
| `AUTH_SECRET` | Secret key used by NextAuth to sign session tokens |
| `TEACHER_SIGNUP_TOKEN` | Secret token teachers must enter when registering at `/register` |
| `ADMIN_SIGNUP_TOKEN` | Secret token admins must enter when registering at `/admin-register` |
| `API_KEY_ENCRYPTION_SECRET` | Hex-encoded 32-byte secret key used to encrypt AI Provider API keys stored in the database |
| `LEARNING_MATERIAL_MAX_BYTES` | Max upload size for learning materials in bytes (default 52428800 = 50 MiB) |
| `AWS_ACCESS_KEY_ID` | **Required.** Static access key for the app's IAM user. IAM instance roles are not used — the app throws rather than falling back to instance metadata |
| `AWS_SECRET_ACCESS_KEY` | **Required.** Static secret key paired with the above |
| `AWS_SESSION_TOKEN` | Optional: only when using temporary STS credentials |
| `AWS_REGION` | AWS S3 region for bucket operations (e.g., `us-east-1`) |
| `AWS_S3_BUCKET` | AWS S3 bucket name |
| `S3_KEY_PREFIX` | Optional namespace for deployments sharing one bucket. Compose fixes prod at `prod/` and dev at `dev/` so their independent garbage collectors cannot delete each other's objects. Existing full keys stored in the database remain readable. |
| `RESOURCE_SPOOL_DIR` | Directory every node writes its **System Resources** samples to, and reads every other node's from. Both compose stacks set it to `/app/metrics` and mount the shared `talent-resource-metrics` volume there, which is how each site charts all four nodes (prod and dev are separate deployments but one EC2 instance). Unset — outside Docker — each deployment keeps a private spool beside its data directory and charts only its own two nodes. |
| `HOST_PROC_DIR` | Where to read the host's CPU/memory counters for the whole-machine panel (default `/proc`, which inside a container is already the host's). Only needs setting if something namespaces `/proc`. |
| `RESOURCE_SAMPLE_INTERVAL_MS` | How often each node records CPU/RAM/storage (default 60000, floor 10000) |
| `RESOURCE_SAMPLE_RETENTION_DAYS` | How long resource samples are kept before each node compacts its spool file (default 7 — the admin tab charts one week) |
| `AWS_S3_ENDPOINT` | Optional: Endpoint URL for S3 alternative providers (MinIO / LocalStack) |
| `CLOUDFRONT_DOMAIN` | CloudFront distribution domain serving images and PDFs (e.g. `d111111abcdef8.cloudfront.net`, or a custom CNAME). A `https://` prefix and trailing slash are tolerated |
| `CLOUDFRONT_KEY_PAIR_ID` | Public key ID from the distribution's trusted key group, used to sign read URLs |
| `CLOUDFRONT_PRIVATE_KEY` | Base64-encoded private key PEM for that key group (`base64 -w0 private_key.pem`); a PEM with literal `\n` escapes also works. **Secret** |

> [!NOTE]
> AI configuration (such as API keys, base URLs, and model selection) is now fully database-backed and managed dynamically via the Admin Dashboard. No `OPENAI_API_KEY` environment variables are required!

### Per-model thinking level

Every model registered in `/admin/ai-config` can be pinned to a **thinking level** (`none`,
`minimal`, `low`, `medium`, `high`, `xhigh`, `max`), sent as `reasoning_effort` on every call that
model serves — OpenAI, Cloudflare AI Gateway, and local OpenAI-compatible servers alike.

The level is **optional and never inferred from the model id**. Leaving it unset omits
`reasoning_effort` from the request body entirely, so non-reasoning models (and local servers that
reject unknown fields) are unaffected — a pinned level only ever changes a call an admin explicitly
opted in. Which levels a given model accepts varies by model; picking an unsupported one surfaces as
a provider error on **Test**, which sends the same request the real use case will.

Because thinking level is part of a model row (like service tier), the same model id can be
registered more than once at different levels and assigned per use case — a cheap `low` extraction
model and a `high` recommendation model on one provider.

The level a run was made with is persisted alongside the other per-run AI metrics — on
`LearningMaterial`, `QuizPdfExtraction`, `QuestionSimulation`, and both `ExamResult` sections — and
rendered by `AiMetricsLine` (`think high`) next to the model, provider, and timings. Both chat
assistants show the same line under each reply, from the stats on the turn's `done` event.

> [!NOTE]
> `AiMetricsLine` renders **nothing** when `NEXT_PUBLIC_APP_ENV=prod`. Model names, tuning, and
> timings are a dev-site diagnostic; students and teachers on the production deployment never see
> them. That single component is the gate — anything that wants to show AI stats should render
> through it rather than formatting its own line.

## Learning materials

Step-by-step **S3 + CloudFront** setup (bucket, CORS, IAM user, distribution, signing key group) is in [docs/SETUP.md](docs/SETUP.md).

Teachers can upload files at `/teacher/materials`. Each upload creates a `LearningMaterial` row with `storageKey`, `bucket`, `uploadStatus`, and metadata. Files live in S3 only; the app never stores file bytes in the SQLite database.

**Uploads** go straight to S3 through short-lived, write-once presigned `PUT` URLs. The client uploads directly to the bucket, then calls the matching completion endpoint so the server can verify every object with `HeadObject`. Configure bucket CORS to allow `PUT` from your web origin and include `Content-Type` and `If-None-Match` in `AllowedHeaders`. The signed `If-None-Match: *` header prevents an upload URL from overwriting an object after it has been validated.

**Reads** go through CloudFront. `signObjectReadUrl()` in `src/lib/storage.ts` is the single entry point for every image and PDF URL the app hands out; it returns a CloudFront signed URL when `CLOUDFRONT_*` is configured and the object sits in the distribution's origin bucket, and otherwise falls back to a presigned S3 GET. The bucket itself stays private (Origin Access Control), so objects are reachable only via a signed CDN URL. Clearing the three `CLOUDFRONT_*` variables reverts delivery to S3 with no code change.

Simulation HTML is the deliberate exception: `/api/simulations/[id]/content` proxies it through the server because the response must carry a restrictive CSP and is rewritten per viewer role, so it is never CDN-cacheable.

For LLM or parsing pipelines, load the row by id and read bytes or location:

- `resolveLearningMaterialLocation(materialId)` — returns `{ material, location }` with S3 bucket and key.
- `readLearningMaterialBytes(materialId)` — returns a `Buffer` from S3.

## Chat assistants

Two floating chat bots, one per audience, mounted from `src/app/(dashboard)/layout.tsx` as a
bottom-right launcher that expands into a panel. The widget self-hides unless the signed-in user's
audience has an assistant an admin has enabled, so no role gate is needed at the mount site.
Admins get neither — they configure the assistants rather than use one.

**Admin setup** (`/admin/ai-config`) has two halves:

1. The `student_assistant` and `teacher_assistant` **use-case assignments**, alongside the existing ones.
   These pick the provider + model, so the assistants reuse the same OpenAI / local /
   Cloudflare-AI-Gateway plumbing, encrypted-key storage, and connection tester as every other AI
   feature. Pick a **vision-capable** model — the assistants take image input.
2. The **Chat Assistants** section, backed by `AssistantConfig` (one row per audience): enabled
   on/off, which skills load, **which individual tools inside those skills are on**, which attachment
   types are accepted, per-message attachment and tool-call caps, how long attachments are kept, how
   much transcript is replayed, per-user hourly message budget, and extra prompt instructions.

   Tool toggles are stored as an opt-*out* list (`disabledTools`), so a tool added to a skill in a
   later release is available to existing installs instead of staying dark until an admin re-saves.
   Disabling every tool in a skill drops the skill entirely — its prompt instructions describe
   abilities by tool name, and keeping them would have the model announce a tool it cannot call. The
   system prompt also ends with the definitive list of callable tools, so a partially disabled skill
   can't overclaim.

Both assistants start **disabled** and stay that way until an admin assigns a model and turns them on.

### Multimodal input

`src/lib/assistant/attachments.ts` is a registry keyed by attachment kind. A kind owns its accepted
MIME types, its byte ceiling, the file-picker `accept` string, and how it renders into model input —
images become a base64 `image_url` part, text-ish files become a fenced text block. Registering
`pdf` (or anything else) later is one entry there plus one in `ATTACHMENT_KINDS`; the agent, the API
route, the admin picker, and the widget all read the registry and need no change.

The browser downscales images to 1568px on the long edge before upload
(`src/components/assistant/attachment-input.ts`), so the admin byte limit is a backstop rather than
the normal constraint. A file that is rejected — wrong type, disabled kind, oversize, over count — is
reported to the model as a system note so the assistant says it couldn't read the file instead of
answering as if it had.

#### Attachment retention

Uploads are kept for `attachmentRetentionDays` (30 by default, per audience) so a later message can
refer back to them. `src/lib/assistant/attachment-store.ts` owns this, on two invariants:

- **Row before object.** The `AssistantAttachment` index row is written first and the S3 upload
  follows, so an object can never exist that no row points at — which makes the retention sweep the
  only deleter the bucket needs. A failed upload rolls the row back.
- **Never fatal.** Unconfigured or unreachable storage costs the conversation its memory of the file,
  not the answer: the attachment still reaches the model inline and the turn completes.

Bytes live in S3 under `assistant-attachments/{userId}/{id}/`, never in the row — a few 5 MiB
payloads per turn would bloat both the SQLite file and every nightly backup of it. The chat route
streams an `attachments` event with the new ids; the client keeps them on its transcript and sends
them back, and the server re-reads those files on later turns, capped at the audience's per-message
attachment limit so replaying a long conversation never costs more than sending the files once.

`GET /api/assistant/attachments/:id` serves one back (a 302 to a short-lived signed URL) for the
panel's thumbnails. Authorization *is* the lookup: the query filters on the session's user id and on
the expiry, so someone else's id and an expired one are both indistinguishable from a nonexistent one.
That matters because these ids live in a client-held transcript the user can edit freely.

The worker sweeps expired rows hourly (`purgeExpiredAssistantAttachments`), deleting object and row
together. A deleted user's attachments go the same way — the row is relation-free precisely so no
cascade can orphan bytes in the bucket that nothing could then find.

### Loadable skills

`src/lib/assistant/skills/` holds the registry. A skill is a declarative bundle — id, name,
description, audience, prompt instructions, and a fixed list of tools:

| Audience | Skill | Tools |
| --- | --- | --- |
| Student | `student-quiz-results` | `search_quiz_results`, `get_quiz_result_detail`, `summarize_performance` |
| Teacher | `teacher-class-insights` | `list_classes`, `get_class_overview`, `get_quiz_breakdown`, `get_student_breakdown`, `find_struggling_students` |

Each tool's `input` is a zod schema that serves as both the JSON Schema advertised to the model
(via `z.toJSONSchema`) and the runtime validator for the arguments it sends back, so the advertised
contract and the enforcement can't drift. Adding a skill is one file plus one line in `REGISTRY`; it
appears in the admin picker for its audience on the next request, because the picker renders from the
code registry rather than a hardcoded list.

The shape deliberately mirrors an MCP server's capability set (id, name, description, tool list with
JSON Schema params), so a skill can later be moved behind an MCP transport without any tool changing
shape. It is in-process today because every tool reads this app's own rows and must be scoped to the
caller — see below.

### What the agent can and cannot do

`src/lib/assistant/agent.ts` runs a bounded tool-calling loop: repeated streaming completions until
the model stops requesting tools or `maxToolCalls` rounds elapse, then one final round with the tools
withheld so a looping model still produces prose. Output streams to the client as NDJSON
(`delta` / `tool` / `done` / `error`), the same transport the exam-results endpoint uses.

There is **no code execution, no shell, and no raw-query tool**. The hand-written handlers in the
registry are the entire capability surface, and every one of them is scoped to the caller's own rows:

- `src/lib/assistant/session.ts` is the only place the audience and the queried identity are decided,
  and both come from the session — never from the request body.
- Student tools anchor on `ctx.studentId`. No student tool accepts a student id, so there is no
  argument the model (or a prompt-injected attachment) could set to read someone else's results.
  A fabricated or another student's `resultId` reads as "not found".
- `get_quiz_result_detail` releases the answer key only for a **final** attempt — one with nothing in
  progress and no retake left (attempts used up, quiz closed, or the quiz no longer offered to the
  class; see `src/lib/quiz-availability.ts`, shared with the student class page). While a retake is
  possible the response omits the correct answers *and* the per-question correct/incorrect flags,
  because on a short option list "you got it wrong" is the answer. It sets `answerKeyWithheld` so the
  assistant explains rather than guesses. Every ambiguous case withholds: an unpublished quiz (one
  click republishes it) and a window that hasn't opened yet both count as retakeable.
- The student prompt carries explicit academic-honesty rules: never hand over a direct answer, a
  rewritten one, or a hint narrow enough to be one, whatever the student claims about having already
  submitted or about what a teacher said. Enforcement is split on purpose — the tool controls what the
  model can *see*, the prompt governs what it does with what it sees, and neither does the other's job.
- Teacher tools resolve every class through an owner-filtered lookup, and `get_student_breakdown`
  additionally checks enrollment — owning a class doesn't imply a given student is in it.
- Teacher payloads drop student emails: the teacher sees them in the UI, but there's no reason to put
  them in a model prompt.
- The system prompt marks attachments and tool results as data, not instructions, and the admin's
  extra instructions are appended under a header stating they cannot override the built-in rules.

Unknown tool names, unparseable arguments, schema violations, and handler throws all become error
*results* handed back to the model rather than exceptions, so it can correct itself instead of the
turn dying.

## Project Structure

```
src/
├── app/
│   ├── (auth)/           # Login, Register, Invite pages
│   ├── (dashboard)/
│   │   ├── teacher/      # Teacher dashboard, classes, topics, questions, materials
│   │   └── student/      # Student dashboard, class view, module quiz
│   └── api/              # API routes
├── components/
│   ├── ui/               # shadcn/ui components
│   └── dashboard/        # Sidebar, shared dashboard components
├── lib/
│   ├── assistant/        # Chat assistants: skill registry, tools, agent loop
│   ├── auth.ts           # NextAuth config
│   ├── prisma.ts         # Prisma client singleton
│   ├── storage.ts        # S3 presigned URLs and object reads
│   ├── learning-material.ts  # Resolve location / read bytes for LLM pipelines
│   └── utils.ts          # Helpers
├── types/                # TypeScript types and enums
prisma/
├── schema.prisma         # Database schema
├── seed.ts               # Seeds topics + 26 thermodynamics questions
└── seed-demo.ts          # Creates demo teacher account (dev only)
```
