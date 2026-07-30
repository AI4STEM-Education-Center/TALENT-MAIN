# Security Notes

This document records the security posture of the app: what has been hardened
in code, the operational procedures those changes depend on, and the residual
items still worth doing. It is the reference for anyone reviewing or extending
the security model.

Most audit findings were fixed in code (see PR #107, commit on `dev`). The
items under **Operational procedures** and **Tracking items** have no safe
one-shot code fix and need a human or a follow-up change.

---

## 1. What has been hardened (in code)

### Access control — class-scoped reads
`src/lib/class-access.ts` centralizes ownership/enrollment checks:

- `getTeacherClass(userId, classId)` — returns the class only if the user is
  the **owning teacher**. Used to gate every class-scoped teacher action.
- `canReadClass(user, classId)` — true for the owning teacher **or** an
  enrolled student. Used for reads that enrolled students legitimately need.

Applied at:

- `GET /api/classes/[id]` — now **owner-only**. Previously any authenticated
  user could read the full roster (student names/emails) and active invitation
  tokens. Returns **404, not 403**, so a non-owner can't even confirm the class
  exists.
- `GET /api/classes/[id]/quizzes` — owner-or-enrolled-student via
  `canReadClass`; 404 otherwise.

**Rule of thumb:** payloads exposing other students' PII or invitation tokens →
gate on `getTeacherClass` (owner-only). Class-scoped reads an enrolled student
needs → `canReadClass`.

### CSRF defense-in-depth
`src/proxy.ts` rejects cross-site **state-changing** API requests with an
explicit `Origin` check on every mutating (`POST`/`PUT`/`PATCH`/`DELETE`)
`/api/` request. This layers on top of the NextAuth session cookie's
`SameSite=Lax` default. Requests with no `Origin` header (server-to-server,
same-origin navigations) are left to the cookie's SameSite protection; a
present-but-mismatched origin gets a 403.

### Rate limiting
`src/lib/rate-limit.ts` — in-memory fixed-window limiter. Current limits
(per IP, per 60s window):

| Endpoint                          | Name                  | Limit |
|-----------------------------------|-----------------------|-------|
| Login (`authorize`)               | `login`               | 10    |
| Teacher register                  | `auth-register`       | 10    |
| Admin register                    | `auth-admin-register` | 10    |
| Invitation validate               | `invite-validate`     | 30    |
| Invitation enroll                 | `invite-enroll`       | 15    |
| Invitation roster lookup          | `invite-lookup`       | 20    |

The login limiter behaves like a failed login (returns `null`) rather than
surfacing a distinct error, so it doesn't leak that throttling is active. The
roster-lookup and invite limits exist to blunt enumeration (the lookup endpoint
reveals roster names by `orgDefinedId`).

**Caveat:** counters live in process memory — they reset on restart and are
**not shared across instances**. This is sized for the current single-instance
deployment. See Tracking item #1 before scaling horizontally.

### Encryption-key rotation
`src/lib/crypto.ts` — secrets at rest (AI provider keys, SMTP, WebDAV) are
encrypted with AES-256-GCM. Decryption now tries the active key first, then any
retired keys from `API_KEY_ENCRYPTION_SECRET_OLD`, so ciphertext keeps
decrypting across a rotation. See the rotation procedure below.

### Request-body validation
`src/lib/validation.ts` — centralized `zod` validation. Routes parse untrusted
JSON through a schema (`parseBody(schema, body)`) instead of hand-rolled
`if (!x?.trim())` checks, so payloads are type-checked (non-strings and
oversized input are rejected) and fail uniformly with a 400. The register
routes use `registerSchema`. **Add new route schemas to this file** rather than
inlining checks.

### Security response headers
`next.config.mjs` sets on every response:

- `Content-Security-Policy-Report-Only` — shipped in **report-only** mode
  first because the app relies on inline scripts (Next bootstrap, next-themes),
  KaTeX inline styles, and cross-origin CloudFront-signed images. Observe
  violations, wire up a report endpoint, then promote to the enforced
  `Content-Security-Policy`. Enforcing it also needs `connect-src` widened to
  the CloudFront domain **and** the S3 host (uploads `fetch` a presigned PUT
  directly to the bucket).
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), browsing-topics=()`
- `Strict-Transport-Security` (max-age 1y, includeSubDomains) — **production
  only**; localhost dev is plain HTTP and must not be HTTPS-pinned.

### Dependency pins
`package.json` adds `overrides` pinning `undici ^7.28.0` and `picomatch
^4.0.3` (transitive security bumps), and adds `zod`.

---

## 2. Operational procedures

### Demo seed credential (`prisma/seed-demo.ts`)
The demo seed no longer contains a password literal or a personal email. It:

- **refuses to run when `NODE_ENV=production`**, and
- reads `DEMO_SEED_PASSWORD` / `DEMO_SEED_EMAIL` / `DEMO_SEED_USERNAME` from the
  environment, generating a random password (printed once) if none is set.

If the previously-committed demo password was reused anywhere, **rotate it**.

### Encryption-key rotation (`src/lib/crypto.ts`)
To rotate `API_KEY_ENCRYPTION_SECRET`:

1. Move the current value into `API_KEY_ENCRYPTION_SECRET_OLD` (comma-separated;
   accepts multiple retired 64-hex keys).
2. Set a fresh 64-hex `API_KEY_ENCRYPTION_SECRET`.
3. Re-encrypt stored secrets by loading + saving each provider/SMTP/WebDAV
   record (new writes use the active key; old ciphertext still decrypts via the
   retired key).
4. Once nothing relies on the old key, remove it from
   `API_KEY_ENCRYPTION_SECRET_OLD`.

Long term, store the master key in a managed secrets service (AWS Secrets
Manager / KMS) instead of a plain env var.

### AWS and CloudFront credential rotation
`src/lib/storage.ts` requires **static** AWS credentials from the environment
(`getAwsCredentials()`); it no longer falls through to an EC2 instance role. That
is deliberate — the credential source is now explicit and a bad `.env` fails
loudly — but it trades away the instance role's automatic rotation, so these are
long-lived secrets in `~/app/.env` that must be rotated deliberately:

- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — the app's IAM user. Scope the
  policy to the bucket and `S3_KEY_PREFIX` only (`docs/SETUP.md`). IAM allows
  two active access keys per user, so rotation is zero-downtime: create the
  second key, deploy it, verify, then delete the first.
- `CLOUDFRONT_PRIVATE_KEY` / `CLOUDFRONT_KEY_PAIR_ID` — the trusted key group's
  signing key. **Anyone holding this private key can mint valid read URLs for
  every object in the bucket.** A key group accepts multiple public keys, so
  rotation is also zero-downtime: add the new public key to the group, deploy
  the new private key + key-pair ID, then remove the old public key once no
  signed URL issued with it can still be in flight (one `PRESIGN_EXPIRES_SEC`
  window, 1h by default).

Never commit `private_key.pem`. Prefer `AWS_SESSION_TOKEN` with short-lived STS
credentials where the deployment can supply them.

### Database schema apply (`docker/docker-entrypoint.sh`)
Production no longer passes `--accept-data-loss` to `prisma db push`: additive
changes still apply automatically, but a **destructive** change makes the push
*refuse* (surfaced in logs) instead of silently dropping data. The longer-term
fix is versioned `prisma migrate deploy`, which requires first establishing a
migration history (`prisma/migrations/`) — there is none today.

### Required environment variables
These must be set with strong, unique values in production. The app degrades or
refuses where they're missing, but verify them on each deploy:

- `API_KEY_ENCRYPTION_SECRET` — 64-hex (32-byte) AES key. **Losing this makes
  all stored provider/SMTP/WebDAV secrets undecryptable.** Back it up securely.
- `ADMIN_SIGNUP_TOKEN` / teacher signup token — gate self-registration. Treat
  as secrets; rotate if leaked.
- `AUTH_SECRET` — session signing. (Only this name is read; `NEXTAUTH_SECRET` is
  not referenced anywhere in the code.)
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — required; object storage fails
  without them. See the rotation note above.
- `CLOUDFRONT_DOMAIN` / `CLOUDFRONT_KEY_PAIR_ID` / `CLOUDFRONT_PRIVATE_KEY` —
  required **together** to serve images and PDFs over the CDN; all three empty
  falls back to presigned S3. A partial set is rejected.

---

## 3. Tracking items (no immediate code change)

1. **Distributed rate limiting.** The in-memory limiter doesn't survive
   restarts or span replicas. Before scaling horizontally, back it with a
   shared store (Redis) so limits hold across instances.
2. **Promote CSP from report-only to enforced.** Wire up a violation report
   endpoint, enumerate the real inline-script / style / connect sources, then
   switch the header to `Content-Security-Policy`. The inline `'unsafe-inline'`
   in `script-src` should ideally be replaced with per-request nonces.
3. **Versioned migrations.** Move from `prisma db push` to
   `prisma migrate deploy` with a checked-in migration history, so schema
   changes are reviewed and reversible rather than applied implicitly.
4. **Master key in a secrets manager.** Move `API_KEY_ENCRYPTION_SECRET` out of
   plain env into AWS Secrets Manager / KMS.
5. **Audit logging.** There is no durable audit trail for sensitive actions
   (logins, role changes, secret reads, roster exports). Consider one.

---

## 4. Tips & conventions for contributors

- **Gate every class-scoped route.** Any handler that takes a `classId` must
  call `getTeacherClass` or `canReadClass` before touching data. Default to the
  stricter one when a payload includes PII or tokens.
- **Return 404, not 403, for unauthorized access to a specific resource** so
  you don't disclose that the resource exists.
- **Validate request bodies with a `zod` schema** in `src/lib/validation.ts` —
  never trust `req.json()` shape. Reject non-strings and bound string length.
- **Rate-limit any unauthenticated or enumeration-prone endpoint** with
  `rateLimit(req, name, limit, windowMs)`; it auto-disables under tests.
- **Never commit secrets or credential literals** (no passwords, tokens, keys,
  or personal emails in seeds, fixtures, or config). Read them from the
  environment and generate randoms for local/dev.
- **Encrypt secrets at rest** with the `crypto.ts` helpers; never store provider
  keys / SMTP / WebDAV credentials in plaintext.
- **Don't weaken the proxy CSRF / auth checks** in `src/proxy.ts` for
  convenience. New public routes still go through the Origin check on mutations.
- **Keep dependencies patched.** Review Dependabot PRs promptly; use
  `overrides` to force transitive security bumps when a direct upgrade isn't
  available yet.
- **Run the full check before merging:** `npx prisma generate && npm test &&
  npm run build`. New security-sensitive code (access checks, limiter, crypto,
  validation) ships with unit tests — see `src/lib/rate-limit.test.ts`,
  `src/lib/crypto.test.ts`, and `test/class-access.route.test.ts`.
