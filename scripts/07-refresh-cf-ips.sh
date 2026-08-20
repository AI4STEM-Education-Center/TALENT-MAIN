#!/usr/bin/env bash
# ============================================================================
# 07 — Re-sync Cloudflare's published edge ranges into the security group and
#      Caddy without opening a direct-origin path.
#
# WHERE: your laptop.
# WHEN:  when Cloudflare announces a range change, or verification reports that
#        either enforcement point is stale.
#
#   ./scripts/07-refresh-cf-ips.sh
#
# Caddy is temporarily given the union of old + new ranges, then AWS converges,
# then Caddy drops removed ranges. That ordering prevents a gap where a valid
# old or newly introduced Cloudflare edge is rejected mid-refresh.
# ============================================================================

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_config
load_state
need_cmd aws jq curl ssh scp
require_vars AWS_REGION CADDY_DIR SG_ID
require_box
refresh_public_ip

step "Fetching current ranges"
V4=$(cf_edge_ranges_v4)
V6=$(cf_edge_ranges_v6)
NEW_RANGES=$(printf '%s\n%s\n' "$V4" "$V6" | grep -v '^$' | sort -u | tr '\n' ' ' | sed 's/ $//')
TOTAL=$(wc -w <<<"$NEW_RANGES" | tr -d ' ')
[[ "$TOTAL" -ge 10 ]] || die "only ${TOTAL} ranges returned — refusing to apply"
ok "${TOTAL} ranges"

CURRENT=$(box_ssh "grep '^CF_TRUSTED_RANGES=' '${CADDY_DIR}/.env' 2>/dev/null | cut -d= -f2-" || true)

set_caddy_ranges() {
  local ranges="$1"
  box_ssh "if grep -q '^CF_TRUSTED_RANGES=' '${CADDY_DIR}/.env'; then
      sed -i 's|^CF_TRUSTED_RANGES=.*|CF_TRUSTED_RANGES=${ranges}|' '${CADDY_DIR}/.env';
    else
      printf '%s\\n' 'CF_TRUSTED_RANGES=${ranges}' >> '${CADDY_DIR}/.env';
    fi
    cd '${CADDY_DIR}' && docker compose -f docker-compose.caddy.yml up -d --wait --wait-timeout 120 --force-recreate"
}

if [[ "$CURRENT" != "$NEW_RANGES" ]]; then
  TRANSITION_RANGES=$(printf '%s\n%s\n' "$CURRENT" "$NEW_RANGES" \
    | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ' | sed 's/ $//')
  step "Allowing the old/new union in Caddy"
  set_caddy_ranges "$TRANSITION_RANGES"
  ok "transition allowlist active"
fi

step "Converging AWS HTTPS rules"
sync_cloudflare_https_rules "$SG_ID" "$V4" "$V6"
sync_public_key_ssh_rule "$SG_ID"
prune_unmanaged_ingress_rules "$SG_ID" "$V4" "$V6"
ok "security group current"

if [[ "$CURRENT" != "$NEW_RANGES" ]]; then
  step "Removing retired ranges from Caddy"
  set_caddy_ranges "$NEW_RANGES"
  ok "Caddy current"
else
  ok "Caddy was already current"
fi

ok "done — verify with ./scripts/09-verify.sh"
