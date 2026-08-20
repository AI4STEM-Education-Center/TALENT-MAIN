#!/usr/bin/env bash
# ============================================================================
# 09 — Verify the whole deployment. Run after the first deploy, and after any
#      infrastructure change.
#
# WHERE: your laptop.
#
#   ./scripts/09-verify.sh
#
# Every check prints PASS or FAIL with the reason. Exit status is the number of
# failures, so this is usable from another script.
#
# One thing it cannot check is the highest-risk one: whether canvas cropping
# still works. That needs a real browser. The manual step is at the end.
# ============================================================================

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_config
need_cmd curl dig aws jq
require_box
refresh_public_ip
require_vars PROD_HOST DEV_HOST S3_BUCKET SG_ID

FAILURES=0
pass() { printf '%s PASS%s %s\n' "$c_green" "$c_reset" "$*"; }
fail() { printf '%s FAIL%s %s\n' "$c_red" "$c_reset" "$*"; FAILURES=$((FAILURES + 1)); }

# ---------------------------------------------------------------------------
step "DNS"
# ---------------------------------------------------------------------------
for host in "$PROD_HOST" "$DEV_HOST"; do
  resolved=$(dig +short "$host" A | head -1)
  if [[ -z "$resolved" ]]; then
    fail "${host} does not resolve"
  elif [[ "$resolved" == "$PUBLIC_IP" ]]; then
    # The single most important check in this file. A grey-clouded record
    # publishes the origin address, and everything downstream — the IP
    # allowlist, the trust in CF-Connecting-IP — assumes it is not published.
    fail "${host} resolves straight to the origin (${PUBLIC_IP}) — the record is not proxied"
  else
    pass "${host} -> ${resolved} (Cloudflare, origin not exposed)"
  fi
done

# ---------------------------------------------------------------------------
step "Origin reachability"
# ---------------------------------------------------------------------------
# Inspect AWS directly: relying on a bare-IP TLS failure is ambiguous because a
# server can reject unknown SNI even when its port is publicly reachable.
V4=$(cf_edge_ranges_v4)
V6=$(cf_edge_ranges_v6)
EXPECTED_HTTPS=$(printf '%s\n%s\n' "$V4" "$V6" | grep -v '^$' | sort -u)
SG_RULES=$(aws_ ec2 describe-security-group-rules \
  --filters "Name=group-id,Values=${SG_ID}" \
  --query 'SecurityGroupRules[?IsEgress==`false`]' --output json 2>/dev/null || true)
if ! jq -e 'type == "array"' >/dev/null <<<"$SG_RULES"; then
  fail "could not read security-group rules for ${SG_ID}"
  SG_RULES='[]'
fi
ACTUAL_HTTPS=$(jq -r '.[] | select(.IpProtocol == "tcp" and .FromPort == 443 and .ToPort == 443) |
  (.CidrIpv4 // .CidrIpv6 // empty)' <<<"${SG_RULES:-[]}" | sort -u)
if [[ "$ACTUAL_HTTPS" == "$EXPECTED_HTTPS" ]]; then
  pass "443/tcp is restricted to all current Cloudflare ranges"
else
  fail "443/tcp security-group ranges do not match Cloudflare's current list"
fi

UNMANAGED=$(jq -r --argjson expected "$(printf '%s\n' "$EXPECTED_HTTPS" | jq -R . | jq -s .)" '.[] |
  (.CidrIpv4 // .CidrIpv6 // "") as $cidr |
  select(
    ((.IpProtocol == "tcp" and .FromPort == 22 and .ToPort == 22 and $cidr == "0.0.0.0/0")
     or (.IpProtocol == "tcp" and .FromPort == 443 and .ToPort == 443 and ($expected | index($cidr))))
    | not
  ) | .SecurityGroupRuleId' <<<"${SG_RULES:-[]}")
if [[ -z "$UNMANAGED" ]]; then
  pass "no unmanaged ingress rules (port 80 and app ports closed)"
else
  fail "unmanaged ingress rules present: $(tr '\n' ' ' <<<"$UNMANAGED")"
fi

if jq -e '.[] | select(.IpProtocol == "tcp" and .FromPort == 22 and .ToPort == 22 and .CidrIpv4 == "0.0.0.0/0")' \
  >/dev/null <<<"${SG_RULES:-[]}"; then
  pass "22/tcp reachable by GitHub Actions (sshd is key-only)"
else
  fail "22/tcp is not reachable by GitHub-hosted runners"
fi

SSHD_EFFECTIVE=$(box_ssh "sudo sshd -T" 2>/dev/null || true)
if grep -qx 'passwordauthentication no' <<<"$SSHD_EFFECTIVE" \
   && grep -qx 'kbdinteractiveauthentication no' <<<"$SSHD_EFFECTIVE" \
   && grep -qx 'permitrootlogin no' <<<"$SSHD_EFFECTIVE" \
   && grep -qx 'authenticationmethods publickey' <<<"$SSHD_EFFECTIVE"; then
  pass "sshd enforces public-key-only, non-root authentication"
else
  fail "sshd effective policy is not fully key-only/root-disabled"
fi

if curl -sS --max-time 8 --resolve "${PROD_HOST}:443:${PUBLIC_IP}" \
     -o /dev/null "https://${PROD_HOST}/" 2>/dev/null; then
  fail "direct origin request with valid SNI answered from a non-Cloudflare source"
else
  pass "direct origin request with valid SNI refused"
fi

for port in 3000 3001; do
  if curl -sS --max-time 5 -o /dev/null "http://${PUBLIC_IP}:${port}" 2>/dev/null; then
    fail "port ${port} is answering on the public interface — an app container is still publishing a port"
  else
    pass "port ${port} closed"
  fi
done

# ---------------------------------------------------------------------------
step "Sites"
# ---------------------------------------------------------------------------
for host in "$PROD_HOST" "$DEV_HOST"; do
  headers=$(curl -sS --max-time 15 -D - -o /dev/null "https://${host}/" 2>/dev/null || true)
  code=$(awk 'NR==1{print $2}' <<<"$headers")
  if [[ -z "$code" ]]; then
    fail "${host} did not respond"
    continue
  fi
  if [[ "$code" =~ ^(200|302|307)$ ]]; then
    pass "${host} responded ${code}"
  else
    fail "${host} responded ${code}"
  fi
  if grep -qi '^server: *cloudflare' <<<"$headers"; then
    pass "${host} served through Cloudflare"
  else
    fail "${host} response did not come from Cloudflare"
  fi
  if grep -qi '^strict-transport-security:' <<<"$headers"; then
    pass "${host} sends HSTS"
  else
    fail "${host} is missing Strict-Transport-Security"
  fi
done

# ---------------------------------------------------------------------------
step "TLS between Cloudflare and the origin"
# ---------------------------------------------------------------------------
# Checked from the box, since we are not allowed to connect from here. A
# self-signed or expired origin certificate breaks Full (Strict) mode.
for host in "$PROD_HOST" "$DEV_HOST"; do
  if box_ssh "docker exec talent-caddy find /data/caddy/certificates -type f -name '${host}.crt' | grep -q ."; then
    pass "Caddy holds a certificate for ${host}"
  else
    fail "Caddy has no certificate for ${host}"
  fi
done

# ---------------------------------------------------------------------------
step "Containers"
# ---------------------------------------------------------------------------
running=$(box_ssh "docker ps --format '{{.Names}}'" 2>/dev/null || true)
for name in talent-caddy talent-web talent-worker \
            talent-web-dev talent-worker-dev; do
  if grep -qx "$name" <<<"$running"; then
    pass "${name} running"
  else
    fail "${name} not running"
  fi
done

if box_ssh "docker network inspect edge --format '{{len .Containers}}'" 2>/dev/null | grep -qE '^[1-9]'; then
  pass "containers attached to the edge network"
else
  fail "nothing is attached to the edge network — Caddy cannot reach the apps"
fi

# ---------------------------------------------------------------------------
step "DDNS"
# ---------------------------------------------------------------------------
if box_ssh "systemctl is-active talent-ddns.timer" 2>/dev/null | grep -q active; then
  pass "DDNS timer active"
else
  fail "DDNS timer is not active — the records will go stale if the IP changes"
fi

if [[ -n "${BACKUP_RCLONE_REMOTE:-}" ]]; then
  if box_ssh "systemctl is-active talent-backup.timer" 2>/dev/null | grep -q active; then
    pass "backup timer active"
  else
    fail "backup timer is not active"
  fi
  backup_result=$(box_ssh "systemctl show talent-backup.service --property=Result --value" 2>/dev/null || true)
  if [[ "$backup_result" == success ]]; then
    pass "most recent off-box backup succeeded"
  else
    fail "most recent off-box backup result is ${backup_result:-unknown}"
  fi
fi

# ---------------------------------------------------------------------------
step "S3 and CloudFront"
# ---------------------------------------------------------------------------
pab=$(aws_ s3api get-public-access-block --bucket "$S3_BUCKET" \
       --query 'PublicAccessBlockConfiguration.[BlockPublicAcls,IgnorePublicAcls,BlockPublicPolicy,RestrictPublicBuckets]' \
       --output text 2>/dev/null || true)
if [[ "$pab" == $'True\tTrue\tTrue\tTrue' ]]; then
  pass "bucket blocks all public access"
else
  fail "bucket public-access block is incomplete: ${pab:-unreadable}"
fi

load_state
if [[ -n "${CLOUDFRONT_DIST_ID:-}" ]]; then
  status=$(aws_ cloudfront get-distribution --id "$CLOUDFRONT_DIST_ID" --query 'Distribution.Status' --output text)
  if [[ "$status" == "Deployed" ]]; then
    pass "distribution Deployed"
  else
    fail "distribution status is ${status}"
  fi

  # An unsigned request must be refused. If this returns 200 the trusted key
  # group is not attached and every stored file is world-readable to anyone who
  # can guess a key.
  code=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' \
    "https://${CLOUDFRONT_DOMAIN}/probe-unsigned" 2>/dev/null || true)
  if [[ "$code" == "403" ]]; then
    pass "unsigned CloudFront request refused (403)"
  else
    fail "unsigned CloudFront request returned ${code:-no response}, expected 403"
  fi

  DIST_CONFIG=$(aws_ cloudfront get-distribution-config --id "$CLOUDFRONT_DIST_ID" \
    --query 'DistributionConfig' --output json 2>/dev/null || true)
  rhp=$(jq -r '.DefaultCacheBehavior.ResponseHeadersPolicyId // empty' <<<"${DIST_CONFIG:-{}}")
  key_group=$(jq -r '.DefaultCacheBehavior.TrustedKeyGroups.Items[0] // empty' <<<"${DIST_CONFIG:-{}}")
  oac=$(jq -r '.Origins.Items[0].OriginAccessControlId // empty' <<<"${DIST_CONFIG:-{}}")
  if [[ -n "${CLOUDFRONT_RHP_ID:-}" && "$rhp" == "$CLOUDFRONT_RHP_ID" ]]; then
    pass "expected CORS response-headers policy attached (${rhp})"
  else
    fail "CORS policy mismatch: attached=${rhp:-none}, expected=${CLOUDFRONT_RHP_ID:-unknown}"
  fi
  if [[ -n "${CLOUDFRONT_KEY_GROUP_ID:-}" && "$key_group" == "$CLOUDFRONT_KEY_GROUP_ID" ]]; then
    pass "expected trusted key group attached (${key_group})"
  else
    fail "trusted key-group mismatch: attached=${key_group:-none}"
  fi
  if [[ -n "${CLOUDFRONT_OAC_ID:-}" && "$oac" == "$CLOUDFRONT_OAC_ID" ]]; then
    pass "expected origin access control attached (${oac})"
  else
    fail "origin access-control mismatch: attached=${oac:-none}"
  fi
else
  warn "no CLOUDFRONT_DIST_ID in .state.env; skipping CloudFront checks"
fi

# ---------------------------------------------------------------------------
printf '\n'
if [[ "$FAILURES" -eq 0 ]]; then
  printf '%sAll automated checks passed.%s\n' "$c_green" "$c_reset"
else
  printf '%s%d check(s) failed.%s\n' "$c_red" "$FAILURES" "$c_reset"
fi

cat <<EOF

${c_yellow}Still to check by hand — nothing here can do it for you:${c_reset}

  1. Sign in to https://${PROD_HOST} as a teacher.
  2. Import a quiz from a PDF, then crop a figure from a page.
     If the crop produces an image, the CloudFront CORS policy is right.
     If it fails, the browser console shows a SecurityError from toBlob() and
     the response-headers policy needs fixing — this is the one failure mode
     that leaves no trace server-side.
  3. Open a learning material PDF and confirm the URL is ${CLOUDFRONT_DOMAIN}
     rather than an s3.amazonaws.com address.
EOF

exit "$FAILURES"
