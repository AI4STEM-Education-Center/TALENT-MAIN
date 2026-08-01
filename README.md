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

# --- AWS S3 (Learning Materials) ---
AWS_REGION="us-east-1"
AWS_S3_BUCKET="talent4ai-101561168021-us-east-1-an"
LEARNING_MATERIAL_MAX_BYTES="52428800"
```

## Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | SQLite connection string used by Prisma for local development (e.g., `file:./data/dev.db`) |
| `PROD_DATABASE_URL` | Production SQLite connection string read by Docker Compose (maps to `DATABASE_URL` in production container) |
| `DEV_DATABASE_URL` | Dev SQLite connection string read by Docker Compose (maps to `DATABASE_URL` in dev container) |
| `DB_PROVIDER` | Set to `sqlite` to run WAL mode optimizations on startup |
| `APP_URL` | Optional public base URL of the deployment (e.g. `https://dev.ai4talent.org`). Automated notification emails use it to link students back to their mailbox; when unset the link is omitted |
| `AUTH_SECRET` | Secret key used by NextAuth to sign session tokens |
| `TEACHER_SIGNUP_TOKEN` | Secret token teachers must enter when registering at `/register` |
| `ADMIN_SIGNUP_TOKEN` | Secret token admins must enter when registering at `/admin-register` |
| `API_KEY_ENCRYPTION_SECRET` | Hex-encoded 32-byte secret key used to encrypt AI Provider API keys stored in the database |
| `LEARNING_MATERIAL_MAX_BYTES` | Max upload size for learning materials in bytes (default 52428800 = 50 MiB) |
| `AWS_REGION` | AWS S3 region for bucket operations (e.g., `us-east-1`) |
| `AWS_S3_BUCKET` | AWS S3 bucket name (e.g., `talent4ai-101561168021-us-east-1-an`) |
| `S3_KEY_PREFIX` | Optional namespace for deployments sharing one bucket. Compose fixes prod at `prod/` and dev at `dev/` so their independent garbage collectors cannot delete each other's objects. Existing full keys stored in the database remain readable. |
| `AWS_S3_ENDPOINT` | Optional: Endpoint URL for S3 alternative providers (MinIO / LocalStack) |
| `AWS_ACCESS_KEY_ID` | Optional: Static access key if not using an IAM role on EC2 |
| `AWS_SECRET_ACCESS_KEY` | Optional: Static secret key if not using an IAM role on EC2 |

> [!NOTE]
> AI configuration (such as API keys, base URLs, and model selection) is now fully database-backed and managed dynamically via the Admin Dashboard. No `OPENAI_API_KEY` environment variables are required!

## Learning materials

Step-by-step **EC2 + S3** setup (bucket, CORS, IAM) is in [docs/S3_EC2_SETUP.md](docs/S3_EC2_SETUP.md). On the server, `ec2-setup.sh` installs `~/app/scripts/check-s3.sh` to verify credentials and bucket access.

Teachers can upload files at `/teacher/materials`. Each upload creates a `LearningMaterial` row with `storageKey`, `bucket`, `uploadStatus`, and metadata. Files live in S3 only; the app never stores file bytes in the SQLite database.

`POST /api/learning-materials` returns a short-lived presigned `PUT` URL; the client uploads directly to S3, then calls `POST /api/learning-materials`/`[id]`/`complete` so the server can verify the object with `HeadObject`. Configure CORS on the bucket to allow `PUT` from your web origin.

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
