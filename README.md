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

## Learning materials

Step-by-step **S3 + CloudFront** setup (bucket, CORS, IAM user, distribution, signing key group) is in [docs/SETUP.md](docs/SETUP.md).

Teachers can upload files at `/teacher/materials`. Each upload creates a `LearningMaterial` row with `storageKey`, `bucket`, `uploadStatus`, and metadata. Files live in S3 only; the app never stores file bytes in the SQLite database.

**Uploads** go straight to S3 through short-lived, write-once presigned `PUT` URLs. The client uploads directly to the bucket, then calls the matching completion endpoint so the server can verify every object with `HeadObject`. Configure bucket CORS to allow `PUT` from your web origin and include `Content-Type` and `If-None-Match` in `AllowedHeaders`. The signed `If-None-Match: *` header prevents an upload URL from overwriting an object after it has been validated.

**Reads** go through CloudFront. `signObjectReadUrl()` in `src/lib/storage.ts` is the single entry point for every image and PDF URL the app hands out; it returns a CloudFront signed URL when `CLOUDFRONT_*` is configured and the object sits in the distribution's origin bucket, and otherwise falls back to a presigned S3 GET. The bucket itself stays private (Origin Access Control), so objects are reachable only via a signed CDN URL. Clearing the three `CLOUDFRONT_*` variables reverts delivery to S3 with no code change.

Simulation HTML is the deliberate exception: `/api/simulations/[id]/content` proxies it through the server because the response must carry a restrictive CSP and is rewritten per viewer role, so it is never CDN-cacheable.

For LLM or parsing pipelines, load the row by id and read bytes or location:

- `resolveLearningMaterialLocation(materialId)` — returns `{ material, location }` with S3 bucket and key.
- `readLearningMaterialBytes(materialId)` — returns a `Buffer` from S3.

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
