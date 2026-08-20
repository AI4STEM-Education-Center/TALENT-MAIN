#!/usr/bin/env bash
# Restore one WebDAV S3 companion into the newly provisioned bucket and update
# only database rows whose object keys were actually recovered.

set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_config
need_cmd aws jq shasum sqlite3
require_vars AWS_REGION S3_BUCKET

MANIFEST="${1:-}"
DB_FILE="${2:-}"
[[ -f "$MANIFEST" && -f "$DB_FILE" ]] \
  || die "usage: $0 <manifest.json> <restored.db>"

BASE_DIR=$(dirname "$MANIFEST")
OLD_BUCKET=$(jq -er '.bucket | select(type == "string" and length > 0)' "$MANIFEST")
PREFIX=$(jq -er '.prefix | select(type == "string")' "$MANIFEST")
OBJECT_COUNT=$(jq -er '.objects | length' "$MANIFEST")

[[ $(jq -r '.version' "$MANIFEST") == 1 ]] || die "unsupported manifest version"
[[ "$OBJECT_COUNT" -gt 0 ]] || die "the snapshot contains no S3 objects"

step "Validating ${OBJECT_COUNT} snapshot objects"
index=0
while IFS=$'\t' read -r key rel expected_size expected_hash content_type; do
  index=$((index + 1))
  [[ -n "$key" && -n "$rel" && "$rel" =~ ^objects/[0-9]{8}\.bin$ ]] \
    || die "invalid manifest entry ${index}"
  [[ -z "$PREFIX" || "$key" == "$PREFIX"* ]] \
    || die "object ${index} is outside manifest prefix ${PREFIX}"
  object_file="${BASE_DIR}/${rel}"
  [[ -f "$object_file" ]] || die "missing ${rel}"
  actual_size=$(stat -c '%s' "$object_file" 2>/dev/null || stat -f '%z' "$object_file")
  [[ "$actual_size" == "$expected_size" ]] || die "size mismatch for ${rel}"
  actual_hash=$(shasum -a 256 "$object_file" | awk '{print $1}')
  [[ "$actual_hash" == "$expected_hash" ]] || die "SHA-256 mismatch for ${rel}"
done < <(jq -r '.objects[] | [.key,.file,(.size|tostring),.sha256,.contentType] | @tsv' "$MANIFEST")
ok "all objects match the manifest"

step "Uploading ${OBJECT_COUNT} objects to ${S3_BUCKET}"
index=0
while IFS=$'\t' read -r key rel content_type; do
  index=$((index + 1))
  object_file="${BASE_DIR}/${rel}"
  aws_ s3api put-object \
    --bucket "$S3_BUCKET" \
    --key "$key" \
    --body "$object_file" \
    --content-type "${content_type:-application/octet-stream}" >/dev/null
  if ((index % 25 == 0 || index == OBJECT_COUNT)); then
    info "uploaded ${index}/${OBJECT_COUNT}"
  fi
done < <(jq -r '.objects[] | [.key,.file,.contentType] | @tsv' "$MANIFEST")

step "Verifying the destination object count"
REMOTE_COUNT=$(aws_ s3api list-objects-v2 --bucket "$S3_BUCKET" --prefix "$PREFIX" \
  --query 'length(Contents || `[]`)' --output text)
[[ "$REMOTE_COUNT" -ge "$OBJECT_COUNT" ]] \
  || die "destination lists ${REMOTE_COUNT} objects under ${PREFIX}; expected at least ${OBJECT_COUNT}"
ok "destination contains the recovered snapshot"

step "Updating recovered database bucket references"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
DB_SAFETY_COPY="${DB_FILE}.before-s3-recovery-${stamp}"
sqlite3 -readonly "$DB_FILE" ".backup '${DB_SAFETY_COPY}'"
chmod 600 "$DB_SAFETY_COPY"

sql_manifest=${MANIFEST//\'/\'\'}
sql_old_bucket=${OLD_BUCKET//\'/\'\'}
sql_new_bucket=${S3_BUCKET//\'/\'\'}

sqlite3 "$DB_FILE" <<SQL
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
CREATE TEMP TABLE RecoveredKeys(key TEXT PRIMARY KEY);
INSERT INTO RecoveredKeys(key)
SELECT json_extract(value, '$.key')
FROM json_each(CAST(readfile('${sql_manifest}') AS TEXT), '$.objects');

UPDATE LearningMaterial
SET bucket = '${sql_new_bucket}'
WHERE bucket = '${sql_old_bucket}' AND storageKey IN (SELECT key FROM RecoveredKeys);
UPDATE QuizPdfExtraction
SET bucket = '${sql_new_bucket}'
WHERE bucket = '${sql_old_bucket}' AND storageKey IN (SELECT key FROM RecoveredKeys);
UPDATE Question
SET figureBucket = '${sql_new_bucket}'
WHERE figureBucket = '${sql_old_bucket}' AND figureStorageKey IN (SELECT key FROM RecoveredKeys);
UPDATE Option
SET imageBucket = '${sql_new_bucket}'
WHERE imageBucket = '${sql_old_bucket}' AND imageStorageKey IN (SELECT key FROM RecoveredKeys);
UPDATE QuestionSimulation
SET bucket = '${sql_new_bucket}'
WHERE bucket = '${sql_old_bucket}' AND storageKey IN (SELECT key FROM RecoveredKeys);
UPDATE ConsentExportJob
SET resultBucket = '${sql_new_bucket}'
WHERE resultBucket = '${sql_old_bucket}' AND resultKey IN (SELECT key FROM RecoveredKeys);
COMMIT;
SQL

[[ $(sqlite3 -readonly "$DB_FILE" 'PRAGMA integrity_check;') == ok ]] \
  || die "database failed integrity_check after bucket migration"
chmod 600 "$DB_FILE"
ok "database references updated; safety copy: ${DB_SAFETY_COPY}"

cat <<EOF

Recovered ${OBJECT_COUNT} object(s) from ${OLD_BUCKET}/${PREFIX} into
${S3_BUCKET}/${PREFIX}. Only rows whose exact keys were in the manifest were
retargeted; unrecovered references still name the old bucket and remain visible
for remediation instead of silently pointing at missing files.
EOF
