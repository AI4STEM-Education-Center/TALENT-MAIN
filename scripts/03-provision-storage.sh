#!/usr/bin/env bash
# ============================================================================
# 03 — S3 bucket, least-privilege IAM user, and the CloudFront distribution
#      that serves every image and PDF.
#
# WHERE: your laptop.
# TIME:  ~2 minutes, plus 5-10 minutes for the distribution to deploy
#        (run with --wait to block until it does).
#
#   ./scripts/03-provision-storage.sh [--wait]
#
# Prints, at the end, the exact block to paste into the box's .env — or run
# 04-app-env.sh, which reads the same values back out of scripts/.state.env.
#
# Safe to re-run: every resource is looked up before it is created. The one
# thing it will not do twice is issue IAM access keys; if the app's keys are
# lost, delete the old key in the console and re-run.
# ============================================================================

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_config
load_state
need_cmd aws jq openssl base64
require_vars PROJECT AWS_REGION S3_BUCKET IAM_USER PROD_HOST DEV_HOST CLOUDFRONT_KEY_DIR

WAIT=false
case "${1:-}" in
  '') ;;
  --wait) WAIT=true ;;
  *) die "usage: $0 [--wait]" ;;
esac

ACCOUNT=$(aws_ sts get-caller-identity --query Account --output text)

# ---------------------------------------------------------------------------
step "S3 bucket ${S3_BUCKET}"
# ---------------------------------------------------------------------------
if aws_ s3api head-bucket --bucket "$S3_BUCKET" 2>/dev/null; then
  ok "exists"
else
  # us-east-1 is the one region where passing a LocationConstraint is an error.
  if [[ "$AWS_REGION" == "us-east-1" ]]; then
    aws_ s3api create-bucket --bucket "$S3_BUCKET" >/dev/null
  else
    aws_ s3api create-bucket --bucket "$S3_BUCKET" \
      --create-bucket-configuration "LocationConstraint=${AWS_REGION}" >/dev/null
  fi
  ok "created"
fi

step "Blocking all public access"
aws_ s3api put-public-access-block --bucket "$S3_BUCKET" \
  --public-access-block-configuration \
  'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true' >/dev/null
ok "bucket is private; CloudFront reaches it through OAC, nothing else can"

# ---------------------------------------------------------------------------
step "Bucket CORS"
# ---------------------------------------------------------------------------
# PUT: the browser uploads straight to S3 with a presigned URL. If-None-Match
# must be allowed because the signed upload URL carries `If-None-Match: *` to
# make it write-once.
# GET: only used when CLOUDFRONT_* is unset (local dev, and the rollback path).
aws_ s3api put-bucket-cors --bucket "$S3_BUCKET" --cors-configuration "$(jq -n \
  --arg prod "https://${PROD_HOST}" --arg dev "https://${DEV_HOST}" '{
  CORSRules: [{
    AllowedOrigins: [$prod, $dev, "http://localhost:3000"],
    AllowedMethods: ["PUT", "GET", "HEAD"],
    AllowedHeaders: ["content-type", "if-none-match", "x-amz-*"],
    ExposeHeaders: ["ETag"],
    MaxAgeSeconds: 3000
  }]
}')" >/dev/null
ok "PUT allowed from ${PROD_HOST}, ${DEV_HOST}, localhost:3000"

# ---------------------------------------------------------------------------
step "IAM user ${IAM_USER}"
# ---------------------------------------------------------------------------
if aws_ iam get-user --user-name "$IAM_USER" >/dev/null 2>&1; then
  ok "exists"
else
  aws_ iam create-user --user-name "$IAM_USER" \
    --tags "Key=Project,Value=${PROJECT}" >/dev/null
  ok "created"
fi

# Exactly the operations src/lib/storage.ts and src/lib/consent-export.ts
# issue: Get/Put/Delete/Head/Copy on objects, ListObjectsV2 for the orphan
# collector, and the multipart actions lib-storage needs for the consent-PDF
# zip. No s3:* and no bucket-level administration — this identity cannot
# change the CORS rules or the public-access block that protect it.
POLICY=$(jq -n --arg b "arn:aws:s3:::${S3_BUCKET}" '{
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "Objects",
      Effect: "Allow",
      Action: [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      Resource: ($b + "/*")
    },
    {
      Sid: "BucketListing",
      Effect: "Allow",
      Action: ["s3:ListBucket", "s3:ListBucketMultipartUploads"],
      Resource: $b
    }
  ]
}')
aws_ iam put-user-policy --user-name "$IAM_USER" \
  --policy-name "${PROJECT}-s3-access" --policy-document "$POLICY" >/dev/null
ok "least-privilege policy attached"

EXISTING_KEYS=$(aws_ iam list-access-keys --user-name "$IAM_USER" \
                 --query 'AccessKeyMetadata[].AccessKeyId' --output text)
if [[ -n "$EXISTING_KEYS" ]]; then
  if [[ -n "${APP_AWS_ACCESS_KEY_ID:-}" && -n "${APP_AWS_SECRET_ACCESS_KEY:-}" ]] \
     && grep -qw -- "$APP_AWS_ACCESS_KEY_ID" <<<"$EXISTING_KEYS"; then
    ok "reusing app key ${APP_AWS_ACCESS_KEY_ID} from protected local state"
  else
    die "${IAM_USER} already has access key(s), but their secret is not in scripts/.state.env. AWS cannot reprint it; delete the lost key deliberately, then rerun."
  fi
else
  KEY_JSON=$(aws_ iam create-access-key --user-name "$IAM_USER")
  AWS_KEY_ID=$(jq -r '.AccessKey.AccessKeyId' <<<"$KEY_JSON")
  AWS_KEY_SECRET=$(jq -r '.AccessKey.SecretAccessKey' <<<"$KEY_JSON")
  state_set APP_AWS_ACCESS_KEY_ID "$AWS_KEY_ID"
  state_set APP_AWS_SECRET_ACCESS_KEY "$AWS_KEY_SECRET"
  ok "issued ${AWS_KEY_ID} (saved to scripts/.state.env, mode 600)"
fi

# ---------------------------------------------------------------------------
step "CloudFront signing key pair"
# ---------------------------------------------------------------------------
mkdir -p "$CLOUDFRONT_KEY_DIR"; chmod 700 "$CLOUDFRONT_KEY_DIR"
PRIV="${CLOUDFRONT_KEY_DIR}/cloudfront-private.pem"
PUB="${CLOUDFRONT_KEY_DIR}/cloudfront-public.pem"
if [[ -f "$PRIV" ]]; then
  ok "reusing ${PRIV}"
else
  openssl genrsa -out "$PRIV" 2048 2>/dev/null
  chmod 600 "$PRIV"
  openssl rsa -pubout -in "$PRIV" -out "$PUB" 2>/dev/null
  ok "generated (2048-bit RSA, the only size CloudFront accepts)"
fi
[[ -f "$PUB" ]] || openssl rsa -pubout -in "$PRIV" -out "$PUB" 2>/dev/null

LOCAL_KEY_SHA=$(openssl pkey -pubin -in "$PUB" -outform DER 2>/dev/null \
  | openssl dgst -sha256 -r | awk '{print $1}')
[[ -n "$LOCAL_KEY_SHA" ]] || die "could not fingerprint ${PUB}"
# CloudFront public keys are immutable. Naming by fingerprint means that if a
# private key is restored/regenerated, it can never be silently paired with an
# older public key that merely has the same friendly name.
PK_NAME="${PROJECT}-signing-${LOCAL_KEY_SHA:0:12}"
PK_ID=$(aws_ cloudfront list-public-keys \
         --query "PublicKeyList.Items[?Name=='${PK_NAME}'].Id | [0]" --output text 2>/dev/null || true)
if [[ -z "$PK_ID" || "$PK_ID" == "None" ]]; then
  PK_ID=$(aws_ cloudfront create-public-key --public-key-config "$(jq -n \
      --arg name "$PK_NAME" --arg key "$(cat "$PUB")" --arg ref "${PK_NAME}-$(date +%s)" \
      '{CallerReference: $ref, Name: $name, EncodedKey: $key, Comment: "TALENT signed image/PDF delivery"}')" \
    --query 'PublicKey.Id' --output text)
  ok "uploaded public key ${PK_ID}"
else
  REMOTE_PUB=$(aws_ cloudfront get-public-key --id "$PK_ID" \
    --query 'PublicKey.PublicKeyConfig.EncodedKey' --output text)
  REMOTE_KEY_SHA=$(printf '%s\n' "$REMOTE_PUB" \
    | openssl pkey -pubin -outform DER 2>/dev/null \
    | openssl dgst -sha256 -r | awk '{print $1}')
  [[ "$REMOTE_KEY_SHA" == "$LOCAL_KEY_SHA" ]] \
    || die "CloudFront public key ${PK_ID} does not match ${PRIV}"
  ok "public key ${PK_ID} matches the local private key"
fi

KG_NAME="${PROJECT}-key-group"
KG_ID=$(aws_ cloudfront list-key-groups \
         --query "KeyGroupList.Items[?KeyGroup.KeyGroupConfig.Name=='${KG_NAME}'].KeyGroup.Id | [0]" \
         --output text 2>/dev/null || true)
if [[ -z "$KG_ID" || "$KG_ID" == "None" ]]; then
  KG_ID=$(aws_ cloudfront create-key-group --key-group-config "$(jq -n \
      --arg name "$KG_NAME" --arg id "$PK_ID" \
      '{Name: $name, Items: [$id], Comment: "Trusted signers for TALENT"}')" \
    --query 'KeyGroup.Id' --output text)
  ok "created key group ${KG_ID}"
else
  KG_DOC=$(aws_ cloudfront get-key-group --id "$KG_ID")
  KG_ETAG=$(jq -r '.ETag' <<<"$KG_DOC")
  KG_CONFIG=$(jq --arg id "$PK_ID" '
    .KeyGroup.KeyGroupConfig
    | .Items = ((.Items + [$id]) | unique)
  ' <<<"$KG_DOC")
  aws_ cloudfront update-key-group --id "$KG_ID" --if-match "$KG_ETAG" \
    --key-group-config "$KG_CONFIG" >/dev/null
  ok "key group ${KG_ID} trusts ${PK_ID} (older rotation keys preserved)"
fi

# ---------------------------------------------------------------------------
step "Origin Access Control"
# ---------------------------------------------------------------------------
OAC_NAME="${PROJECT}-oac"
OAC_ID=$(aws_ cloudfront list-origin-access-controls \
          --query "OriginAccessControlList.Items[?Name=='${OAC_NAME}'].Id | [0]" --output text 2>/dev/null || true)
if [[ -z "$OAC_ID" || "$OAC_ID" == "None" ]]; then
  OAC_ID=$(aws_ cloudfront create-origin-access-control --origin-access-control-config "$(jq -n \
      --arg name "$OAC_NAME" '{
        Name: $name,
        Description: "TALENT private S3 origin",
        SigningProtocol: "sigv4",
        SigningBehavior: "always",
        OriginAccessControlOriginType: "s3"
      }')" --query 'OriginAccessControl.Id' --output text)
  ok "created ${OAC_ID}"
else
  OAC_DOC=$(aws_ cloudfront get-origin-access-control --id "$OAC_ID")
  OAC_ETAG=$(jq -r '.ETag' <<<"$OAC_DOC")
  OAC_CONFIG=$(jq --arg name "$OAC_NAME" '
    .OriginAccessControl.OriginAccessControlConfig
    | .Name = $name
    | .Description = "TALENT private S3 origin"
    | .SigningProtocol = "sigv4"
    | .SigningBehavior = "always"
    | .OriginAccessControlOriginType = "s3"
  ' <<<"$OAC_DOC")
  aws_ cloudfront update-origin-access-control --id "$OAC_ID" --if-match "$OAC_ETAG" \
    --origin-access-control-config "$OAC_CONFIG" >/dev/null
  ok "${OAC_ID} exists and is current"
fi

# ---------------------------------------------------------------------------
step "CORS response-headers policy"
# ---------------------------------------------------------------------------
# NOT optional. src/components/quiz/QuizPdfImport.tsx loads a page image with
# crossOrigin="anonymous", draws it to a canvas and calls toBlob(). Without
# Access-Control-Allow-Origin on the CloudFront response the canvas is tainted
# and toBlob throws SecurityError — figure and answer-choice cropping stops
# working, with no server-side error to notice.
RHP_NAME="${PROJECT}-cors"
RHP_ID=$(aws_ cloudfront list-response-headers-policies --type custom \
          --query "ResponseHeadersPolicyList.Items[?ResponseHeadersPolicy.ResponseHeadersPolicyConfig.Name=='${RHP_NAME}'].ResponseHeadersPolicy.Id | [0]" \
          --output text 2>/dev/null || true)
RHP_CONFIG=$(jq -n --arg name "$RHP_NAME" --arg prod "https://${PROD_HOST}" --arg dev "https://${DEV_HOST}" '{
  Name: $name,
  Comment: "Allow canvas reads of quiz page images",
  CorsConfig: {
    AccessControlAllowOrigins: { Quantity: 2, Items: [$prod, $dev] },
    AccessControlAllowHeaders: { Quantity: 1, Items: ["*"] },
    AccessControlAllowMethods: { Quantity: 2, Items: ["GET", "HEAD"] },
    AccessControlAllowCredentials: false,
    AccessControlMaxAgeSec: 3000,
    OriginOverride: true
  }
}')
if [[ -z "$RHP_ID" || "$RHP_ID" == "None" ]]; then
  RHP_ID=$(aws_ cloudfront create-response-headers-policy \
    --response-headers-policy-config "$RHP_CONFIG" \
    --query 'ResponseHeadersPolicy.Id' --output text)
  ok "created ${RHP_ID}"
else
  ETAG=$(aws_ cloudfront get-response-headers-policy --id "$RHP_ID" --query 'ETag' --output text)
  aws_ cloudfront update-response-headers-policy --id "$RHP_ID" --if-match "$ETAG" \
    --response-headers-policy-config "$RHP_CONFIG" >/dev/null
  ok "updated ${RHP_ID} (origins re-synced from config.env)"
fi

# ---------------------------------------------------------------------------
step "Distribution"
# ---------------------------------------------------------------------------
ORIGIN_DOMAIN="${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com"
DIST_COMMENT="${PROJECT} signed media delivery"
DIST_ID="${CLOUDFRONT_DIST_ID:-}"
if [[ -z "$DIST_ID" ]]; then
  DIST_ID=$(aws_ cloudfront list-distributions \
             --query "DistributionList.Items[?Comment=='${DIST_COMMENT}'].Id | [0]" --output text 2>/dev/null || true)
fi

if [[ -z "$DIST_ID" || "$DIST_ID" == "None" ]]; then
  # Managed-CachingOptimized. Its cache key excludes query strings, which is
  # exactly right here: the signature rotates hourly and lives in the query
  # string, so including it would give every viewer a private cache entry and
  # the CDN would never serve a hit.
  readonly MANAGED_CACHING_OPTIMIZED=658327ea-f89d-4fab-a63d-7e88639e58f6
  DIST_JSON=$(jq -n \
    --arg ref "${PROJECT}-$(date +%s)" \
    --arg domain "$ORIGIN_DOMAIN" \
    --arg oac "$OAC_ID" \
    --arg kg "$KG_ID" \
    --arg rhp "$RHP_ID" \
    --arg cache "$MANAGED_CACHING_OPTIMIZED" \
    --arg comment "$DIST_COMMENT" '{
    CallerReference: $ref,
    Comment: $comment,
    Enabled: true,
    # North America + Europe. Widen to PriceClass_All only if viewers outside
    # those regions complain about latency; it costs more per GB.
    PriceClass: "PriceClass_100",
    Origins: {
      Quantity: 1,
      Items: [{
        Id: "s3-origin",
        DomainName: $domain,
        OriginAccessControlId: $oac,
        S3OriginConfig: { OriginAccessIdentity: "" }
      }]
    },
    DefaultCacheBehavior: {
      TargetOriginId: "s3-origin",
      ViewerProtocolPolicy: "redirect-to-https",
      AllowedMethods: { Quantity: 2, Items: ["GET", "HEAD"],
                        CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] } },
      Compress: true,
      CachePolicyId: $cache,
      ResponseHeadersPolicyId: $rhp,
      TrustedKeyGroups: { Enabled: true, Quantity: 1, Items: [$kg] }
    }
  }')
  DIST_ID=$(aws_ cloudfront create-distribution --distribution-config "$DIST_JSON" \
             --query 'Distribution.Id' --output text)
  ok "created ${DIST_ID}"
else
  DIST_DOC=$(aws_ cloudfront get-distribution-config --id "$DIST_ID")
  DIST_ETAG=$(jq -r '.ETag' <<<"$DIST_DOC")
  CURRENT_DIST_CONFIG=$(jq '.DistributionConfig' <<<"$DIST_DOC")
  DESIRED_DIST_CONFIG=$(jq \
    --arg domain "$ORIGIN_DOMAIN" \
    --arg oac "$OAC_ID" \
    --arg kg "$KG_ID" \
    --arg rhp "$RHP_ID" \
    --arg cache '658327ea-f89d-4fab-a63d-7e88639e58f6' \
    --arg comment "$DIST_COMMENT" '
      .Comment = $comment
      | .Enabled = true
      | .PriceClass = "PriceClass_100"
      | .Origins = {
          Quantity: 1,
          Items: [{
            Id: "s3-origin",
            DomainName: $domain,
            OriginAccessControlId: $oac,
            S3OriginConfig: {OriginAccessIdentity: ""}
          }]
        }
      | .DefaultCacheBehavior.TargetOriginId = "s3-origin"
      | .DefaultCacheBehavior.ViewerProtocolPolicy = "redirect-to-https"
      | .DefaultCacheBehavior.AllowedMethods = {
          Quantity: 2,
          Items: ["GET", "HEAD"],
          CachedMethods: {Quantity: 2, Items: ["GET", "HEAD"]}
        }
      | .DefaultCacheBehavior.Compress = true
      | .DefaultCacheBehavior.CachePolicyId = $cache
      | del(.DefaultCacheBehavior.ForwardedValues)
      | .DefaultCacheBehavior.ResponseHeadersPolicyId = $rhp
      | .DefaultCacheBehavior.TrustedSigners = {Enabled:false,Quantity:0}
      | .DefaultCacheBehavior.TrustedKeyGroups = {
          Enabled: true, Quantity: 1, Items: [$kg]
        }
    ' <<<"$CURRENT_DIST_CONFIG")

  if [[ "$(jq -Sc . <<<"$CURRENT_DIST_CONFIG")" == "$(jq -Sc . <<<"$DESIRED_DIST_CONFIG")" ]]; then
    ok "${DIST_ID} exists and is current"
  else
    aws_ cloudfront update-distribution --id "$DIST_ID" --if-match "$DIST_ETAG" \
      --distribution-config "$DESIRED_DIST_CONFIG" >/dev/null
    ok "updated ${DIST_ID} (origin, OAC, signer, cache and CORS reconciled)"
  fi
fi

DIST_DOMAIN=$(aws_ cloudfront get-distribution --id "$DIST_ID" --query 'Distribution.DomainName' --output text)
DIST_ARN="arn:aws:cloudfront::${ACCOUNT}:distribution/${DIST_ID}"

# ---------------------------------------------------------------------------
step "Bucket policy for the distribution"
# ---------------------------------------------------------------------------
# Grants read to the CloudFront service principal, and only when the request
# carries this distribution's ARN — so another account's distribution cannot be
# pointed at the bucket. Note this is an Allow, not a Deny: the IAM user's own
# identity policy still authorizes the presigned uploads.
aws_ s3api put-bucket-policy --bucket "$S3_BUCKET" --policy "$(jq -n \
  --arg b "arn:aws:s3:::${S3_BUCKET}/*" --arg arn "$DIST_ARN" '{
  Version: "2008-10-17",
  Statement: [{
    Sid: "AllowCloudFrontServicePrincipalReadOnly",
    Effect: "Allow",
    Principal: { Service: "cloudfront.amazonaws.com" },
    Action: "s3:GetObject",
    Resource: $b,
    Condition: { StringEquals: { "AWS:SourceArn": $arn } }
  }]
}')" >/dev/null
ok "attached"

state_set CLOUDFRONT_DOMAIN "$DIST_DOMAIN"
state_set CLOUDFRONT_KEY_PAIR_ID "$PK_ID"
state_set CLOUDFRONT_DIST_ID "$DIST_ID"
state_set CLOUDFRONT_KEY_GROUP_ID "$KG_ID"
state_set CLOUDFRONT_OAC_ID "$OAC_ID"
state_set CLOUDFRONT_RHP_ID "$RHP_ID"
state_set CLOUDFRONT_PRIVATE_KEY_B64 "$(base64 < "$PRIV" | tr -d '\n')"

if $WAIT; then
  step "Waiting for the distribution to deploy (5-10 min)"
  aws_ cloudfront wait distribution-deployed --id "$DIST_ID"
  ok "deployed"
else
  info "distribution is deploying; check with:"
  info "  aws cloudfront get-distribution --id ${DIST_ID} --query 'Distribution.Status'"
fi

cat <<EOF

${c_green}Storage ready.${c_reset}

  bucket        ${S3_BUCKET}
  distribution  ${DIST_ID}  (${DIST_DOMAIN})
  key pair id   ${PK_ID}
  private key   ${PRIV}

These values are in scripts/.state.env; 04-app-env.sh writes them into the
box's .env for you. Back up ${PRIV} somewhere durable — losing it means
generating a new key pair and updating the key group.

Next: ./scripts/04-app-env.sh on your laptop.
EOF
