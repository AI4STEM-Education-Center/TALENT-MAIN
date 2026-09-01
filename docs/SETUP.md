# S3 + CloudFront Setup

How to provision object storage and image/PDF delivery for this app from scratch.

**The model:** one **private** S3 bucket holds every uploaded PDF and every
rasterized page, figure crop and simulation artifact. Nothing in it is public.

- **Uploads** go browser → S3 directly, using short-lived presigned `PUT` URLs.
  This is why the bucket needs a CORS policy.
- **Reads** go browser → CloudFront, using short-lived **signed URLs**. CloudFront
  reaches the bucket through Origin Access Control (OAC); the bucket itself
  refuses direct public access.
- **Credentials are explicit.** The app reads a static IAM access key from
  `~/app/.env`. It does *not* use an EC2 instance role — `getAwsCredentials()` in
  `src/lib/storage.ts` throws if the keys are absent, so a misconfigured
  environment fails with a clear message instead of silently depending on
  whichever identity the host happens to provide.

Everything below is one-time AWS console/CLI work. Substitute your own values for
`BUCKET`, `REGION`, and `APP_ORIGIN`.

```bash
BUCKET=your-bucket-name
REGION=us-east-1
APP_ORIGIN=https://your-app.example.org
```

---

## 1. Create the bucket

```bash
aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
  $( [ "$REGION" = us-east-1 ] || echo --create-bucket-configuration "LocationConstraint=$REGION" )

# Keep every form of public access off. CloudFront + OAC does not need it.
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
```

### One bucket, two environments

Production and development share this bucket and are separated by
`S3_KEY_PREFIX`, which Docker Compose pins to `prod/` and `dev/`
(`docker/docker-compose.yml`, `docker/docker-compose.dev.yml`). This matters
because the app runs an S3 garbage collector (`src/lib/s3-gc.ts`, scheduled every
6h from `src/worker.ts`) that deletes objects with no database reference. The
prefix is what stops the dev GC from deleting production objects and vice versa —
**do not point two environments with different databases at the same prefix.**

Key layout under the prefix (see `src/lib/storage.ts`):

```
<prefix>learning-materials/{teacherId}/{classId}/{materialId}/{file}
<prefix>learning-materials/{teacherId}/{classId}/{materialId}/pages/page-N.webp
<prefix>quiz-extractions/{teacherId|pool}/{quizId}/{extractionId}/{file}
<prefix>quiz-extractions/{teacherId|pool}/{quizId}/{extractionId}/pages/page-N.webp
<prefix>quiz-extractions/{teacherId|pool}/{quizId}/{extractionId}/figures/figure-N.webp
<prefix>simulations/{teacherId|pool}/{quizId}/{questionId}/v{n}.html
```

Page renders and figure crops are WebP; objects written before that switch keep
their `.png` keys and are still served, so both extensions appear in an
established bucket. `NEXT_PUBLIC_PAGE_IMAGE_FORMAT=png` renders new pages as PNG
again — only needed for a local model server that cannot decode WebP.

Objects are never overwritten in place — simulations are versioned `v{n}.html`
because deep-copied quizzes share keys. That immutability is what makes long CDN
cache TTLs safe.

---

## 2. Bucket CORS (required by the upload path)

Uploads `PUT` straight to S3 from the browser, so the bucket needs CORS even
though reads go through CloudFront.

`cors.json`:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://your-app.example.org", "http://localhost:3000"],
      "AllowedMethods": ["PUT", "GET", "HEAD"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3000
    }
  ]
}
```

```bash
aws s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration file://cors.json
```

---

## 3. IAM user for the app

The app needs an access key scoped to this bucket.

`s3-policy.json` — replace `BUCKET`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ObjectAccess",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::BUCKET/*"
    },
    {
      "Sid": "ListForGarbageCollection",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::BUCKET"
    }
  ]
}
```

These permissions cover every S3 operation the code issues: `PutObject`,
`GetObject`, `HeadObject` (covered by `s3:GetObject`), `DeleteObject`, and
`ListObjectsV2` (`s3:ListBucket`, needed by the garbage collector). The global
material-pool flow also uses `CopyObject`, which S3 authorizes as
`s3:GetObject` on the source plus `s3:PutObject` on the destination.

The example intentionally permits legacy unprefixed keys as well as both
Compose prefixes. Once every stored database key starts with `prod/` or `dev/`,
you can tighten the object resources and the `s3:ListBucket` prefix condition to
those two namespaces.

```bash
aws iam create-user --user-name talent-app
aws iam put-user-policy --user-name talent-app \
  --policy-name talent-s3 --policy-document file://s3-policy.json
aws iam create-access-key --user-name talent-app
```

Put the returned `AccessKeyId` / `SecretAccessKey` into `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`. IAM allows two active keys per user, which is what makes
rotation zero-downtime — see the rotation runbook in `SECURITY.md`.

---

## 4. Signing key group

CloudFront signed URLs are what keep private objects private. Generate a key pair
and register the public half as a trusted key group.

```bash
openssl genrsa -out private_key.pem 2048
openssl rsa -pubout -in private_key.pem -out public_key.pem
```

> `private_key.pem` is a **secret**. Anyone holding it can mint a valid read URL
> for any object in the bucket. Never commit it.

In the CloudFront console: **Key management → Public keys → Create public key**
(paste `public_key.pem`), then **Key groups → Create key group** containing it.
Note the **public key ID** — that is `CLOUDFRONT_KEY_PAIR_ID`.

Encode the private key for `.env`. A `.env` read by Docker Compose's `env_file:`
cannot contain newlines, so base64 it onto one line:

```bash
base64 -w0 private_key.pem      # macOS: base64 -i private_key.pem | tr -d '\n'
```

That string is `CLOUDFRONT_PRIVATE_KEY`. (A PEM with literal `\n` escape
sequences is also accepted, but base64 avoids all quoting questions.)

---

## 5. CloudFront distribution

Create a distribution with the bucket as origin. The settings that matter:

| Setting | Value | Why |
|---|---|---|
| Origin | the S3 bucket | |
| Origin access | **Origin Access Control**, S3 origin type | Lets CloudFront read a bucket that blocks all public access |
| Viewer protocol policy | Redirect HTTP to HTTPS | |
| Allowed methods | `GET, HEAD` | Reads only; uploads bypass the CDN |
| **Restrict viewer access** | **Yes → the key group from step 4** | This is what enforces signed URLs. Without it every object is world-readable to anyone who learns a key |
| Cache policy | `Managed-CachingOptimized` | See the note below |
| Response headers policy | a **CORS** policy (see below) | **Required** — figure cropping breaks without it |

When you create the OAC, CloudFront offers a generated bucket policy — apply it.
It looks like this, and grants read access only to this distribution:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "cloudfront.amazonaws.com" },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::BUCKET/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::ACCOUNT_ID:distribution/DISTRIBUTION_ID"
        }
      }
    }
  ]
}
```

### Cache policy — why `Managed-CachingOptimized` is the right pick

Signed URLs carry rotating `Expires`, `Signature` and `Key-Pair-Id` query
parameters. `Managed-CachingOptimized` **excludes query strings from the cache
key**, so two users holding differently-signed URLs for the same object share one
cache entry instead of fragmenting it. Combined with the immutable key layout
from step 1, generous TTLs are safe (default 1 day, max 1 year).

The app does not set `Cache-Control` on uploaded objects — doing so would require
every browser upload to send a matching header on its presigned `PUT`. Rely on
the cache policy's Min/Default TTL instead, which caches regardless.

### Response headers policy — the CORS requirement

Create a response headers policy with CORS configured:

- `Access-Control-Allow-Origin`: your app origin(s)
- `Access-Control-Allow-Methods`: `GET, HEAD`
- `Access-Control-Allow-Headers`: `*`

**This is not optional.** The quiz PDF figure cropper
(`src/components/quiz/QuizPdfImport.tsx`) loads the page image with
`crossOrigin="anonymous"`, draws it to a canvas and calls `toBlob()`. If the
CloudFront response lacks `Access-Control-Allow-Origin`, the canvas taints and
`toBlob` throws `SecurityError` — figure and answer-choice cropping silently
stops working. Setting the header at the edge (rather than forwarding `Origin` to
S3) also keeps the cache key clean.

### Optional custom domain

To serve from `cdn.your-app.example.org`: request an ACM certificate **in
us-east-1** (CloudFront only reads certs from that region), add the domain as an
alternate domain name on the distribution, and point a DNS CNAME at the
distribution domain.

---

## 6. Server `.env`

Docker Compose reads `~/app/.env` via `env_file:` for all four services (`web`,
`worker`, `web-dev`, `worker-dev`), so these variables reach every process. One
distribution serves both prod and dev because their keys differ by prefix.

```bash
# --- AWS credentials (required) ---
AWS_ACCESS_KEY_ID="AKIA..."
AWS_SECRET_ACCESS_KEY="..."

# --- S3 ---
AWS_REGION="us-east-1"
AWS_S3_BUCKET="your-bucket-name"
LEARNING_MATERIAL_MAX_BYTES="52428800"
# Optional; leave unset for the WebP default (see the key layout above).
NEXT_PUBLIC_PAGE_IMAGE_FORMAT=""

# --- CloudFront ---
CLOUDFRONT_DOMAIN="d111111abcdef8.cloudfront.net"
CLOUDFRONT_KEY_PAIR_ID="K2JCJMDEHXQW5F"
CLOUDFRONT_PRIVATE_KEY="LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLQo..."
```

Do **not** set `S3_KEY_PREFIX` here — Compose sets it per environment.

Leaving all three `CLOUDFRONT_*` variables empty is valid and makes the app serve
reads from S3 with presigned URLs (the local-dev and MinIO path). Setting only
*some* of them is rejected, because a half-configured CDN cannot sign anything
and silently falling back would hide the mistake.

---

## 7. Verification

After deploying with the new environment:

1. **Credentials load.** Watch the worker log through one GC cycle (~6h, or
   restart it) for absence of `S3_GC_FAILED`.
2. **Reads come from the CDN.** Open a quiz with a figure; every `<img>` src
   should be `https://<CLOUDFRONT_DOMAIN>/...`. Reload and confirm
   `x-cache: Hit from cloudfront` in DevTools.
3. **CORS works — do not skip this.** Import a quiz PDF, reach the figure
   cropper, drag a box and commit. Confirm `Access-Control-Allow-Origin` on the
   page-image response.
4. **Uploads still work.** Upload a multi-page PDF end to end. Requests should go
   to the S3 host, and the pages should then render via CloudFront.
5. **Material-pool copies work.** Approve a processed learning material into the
   global pool, then import it into a class. Its copied pages should render via
   CloudFront; this exercises the rebased `CopyObject` path.
6. **Direct S3 access is blocked:**
   `curl -I "https://$BUCKET.s3.$REGION.amazonaws.com/<key>"` → **403**.
7. **Unsigned CDN access is blocked:**
   `curl -I "https://$CLOUDFRONT_DOMAIN/<key>"` → **403 MissingKey**. If this
   returns 200, the key group is not attached and every object is public.
8. **Signatures expire.** Copy a working image URL, wait past its `Expires`, and
   re-fetch → **403**.
9. **PDFs open.** Admin → material detail → *Open original file*.
10. **Simulations unchanged.** Open a question simulation; the iframe should still
   point at `/api/simulations/[id]/content` (server-proxied, not the CDN).

---

## 8. Rollback

Delivery falls back to S3 with no code change and no redeploy of the image:

```bash
# in ~/app/.env
CLOUDFRONT_DOMAIN=""
CLOUDFRONT_KEY_PAIR_ID=""
CLOUDFRONT_PRIVATE_KEY=""
```

Then `docker compose up -d --force-recreate`. Reads revert to presigned S3 GETs.
Note the bucket policy still blocks public access, which is fine — presigned URLs
are authenticated by the app's IAM credentials, not by public ACLs.
