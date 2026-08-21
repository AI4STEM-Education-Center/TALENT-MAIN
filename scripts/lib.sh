#!/usr/bin/env bash
# Shared helpers. Sourced by every numbered script; not executable on its own.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[1]:-$0}")" && pwd)"
CONFIG_FILE="${CONFIG_FILE:-${SCRIPT_DIR}/config.env}"

c_reset=$'\033[0m'; c_blue=$'\033[34m'; c_green=$'\033[32m'
c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_dim=$'\033[2m'

step() { printf '%s==>%s %s\n' "$c_blue" "$c_reset" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$c_green" "$c_reset" "$*"; }
warn() { printf '%swarn%s %s\n' "$c_yellow" "$c_reset" "$*" >&2; }
info() { printf '%s     %s%s\n' "$c_dim" "$*" "$c_reset"; }
die()  { printf '%sFAIL%s %s\n' "$c_red" "$c_reset" "$*" >&2; exit 1; }

load_config() {
  [[ -f "$CONFIG_FILE" ]] || die "no $CONFIG_FILE — copy scripts/config.env.example to scripts/config.env and fill it in"

  local perms
  perms=$(stat -c '%a' "$CONFIG_FILE" 2>/dev/null || stat -f '%Lp' "$CONFIG_FILE")
  # It holds a Cloudflare token, a GHCR PAT and the app's encryption secret.
  # Correct the mode before sourcing or generating anything into it.
  if [[ "$perms" != 600 ]]; then
    chmod 600 "$CONFIG_FILE"
    info "restricted $CONFIG_FILE from mode $perms to 600"
  fi

  set -a
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
  set +a
}

# require_vars VAR1 VAR2 ... — fail listing every missing one at once, so a
# half-filled config surfaces in one run instead of one error per attempt.
require_vars() {
  local missing=()
  for v in "$@"; do
    [[ -n "${!v:-}" ]] || missing+=("$v")
  done
  if ((${#missing[@]})); then
    printf '%sFAIL%s these are empty in %s:\n' "$c_red" "$c_reset" "$CONFIG_FILE" >&2
    printf '       - %s\n' "${missing[@]}" >&2
    exit 1
  fi
}

need_cmd() {
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "missing command: $c"
  done
}

# aws wrapper that honours AWS_PROFILE/AWS_REGION from config without every
# call site repeating the flags.
# NB: every conditional append below is a full `if`, never `[[ ... ]] && x`.
# Under `set -e` the short form exits the whole script whenever the test is
# false, which for an optional value is the normal case, not an error.
aws_() {
  local args=(--region "$AWS_REGION")
  if [[ -n "${AWS_PROFILE:-}" ]]; then args+=(--profile "$AWS_PROFILE"); fi
  command aws "${args[@]}" "$@"
}

# ---- Cloudflare ------------------------------------------------------------

cf_api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -X "$method"
    -H "Authorization: Bearer ${CF_API_TOKEN}"
    -H "Content-Type: application/json")
  if [[ -n "$body" ]]; then args+=(--data "$body"); fi
  curl "${args[@]}" "https://api.cloudflare.com/client/v4${path}"
}

cf_check() {
  local resp="$1" what="$2"
  if [[ "$(jq -r '.success' <<<"$resp")" != "true" ]]; then
    printf '%sFAIL%s Cloudflare API: %s\n' "$c_red" "$c_reset" "$what" >&2
    jq -r '.errors[]? | "       [\(.code)] \(.message)"' <<<"$resp" >&2
    exit 1
  fi
}

cf_zone_id() {
  local resp
  resp=$(cf_api GET "/zones?name=${CF_ZONE}&status=active")
  cf_check "$resp" "look up zone ${CF_ZONE}"
  local id
  id=$(jq -r '.result[0].id // empty' <<<"$resp")
  [[ -n "$id" ]] || die "zone ${CF_ZONE} not found, or the token lacks Zone:Read on it"
  printf '%s' "$id"
}

# Cloudflare's published edge ranges. Everything that filters traffic — the
# security group and the Caddyfile — is generated from this one call, so the
# two can never drift apart.
cf_edge_ranges_v4() { curl -fsS https://www.cloudflare.com/ips-v4 | grep -v '^$'; }
cf_edge_ranges_v6() { curl -fsS https://www.cloudflare.com/ips-v6 | grep -v '^$'; }

# ---- AWS security-group ingress -------------------------------------------
#
# Only HTTPS is exposed to Cloudflare. HTTP-01 is not used (Caddy uses DNS-01)
# and Cloudflare redirects HTTP at its own edge, so publishing port 80 would
# double the number of rules for no benefit. The ~22 published v4/v6 CIDRs fit
# comfortably below the default 60-rule quota when each appears once on 443.

authorize_cidr_rule() {
  local sg_id="$1" port="$2" cidr="$3" description="$4" permission out
  permission=$(jq -nc --arg cidr "$cidr" --arg description "$description" \
    --argjson port "$port" '
      if ($cidr | contains(":")) then
        [{IpProtocol:"tcp",FromPort:$port,ToPort:$port,
          Ipv6Ranges:[{CidrIpv6:$cidr,Description:$description}]}]
      else
        [{IpProtocol:"tcp",FromPort:$port,ToPort:$port,
          IpRanges:[{CidrIp:$cidr,Description:$description}]}]
      end')

  if out=$(aws_ ec2 authorize-security-group-ingress --group-id "$sg_id" \
            --ip-permissions "$permission" 2>&1); then
    info "allowed ${port}/tcp from ${cidr}"
  elif grep -q 'InvalidPermission.Duplicate' <<<"$out"; then
    return 0
  else
    die "authorizing ${port}/tcp from ${cidr}: ${out}"
  fi
}

revoke_rule_ids() {
  local sg_id="$1"
  shift
  (($#)) || return 0
  aws_ ec2 revoke-security-group-ingress --group-id "$sg_id" \
    --security-group-rule-ids "$@" >/dev/null
}

# Converge the 443 rules on exactly the current Cloudflare ranges. Legacy
# prefix-list and port-80 rules are removed first so an installation made by an
# older script cannot consume the quota needed for the replacement rules.
sync_cloudflare_https_rules() {
  local sg_id="$1" v4="$2" v6="$3" desired rules cidr id protocol
  desired=$(printf '%s\n%s\n' "$v4" "$v6" | grep -v '^$' | sort -u)
  [[ $(wc -l <<<"$desired" | tr -d ' ') -ge 10 ]] \
    || die "refusing to apply an unexpectedly short Cloudflare range list"

  rules=$(aws_ ec2 describe-security-group-rules \
    --filters "Name=group-id,Values=${sg_id}" \
    --query 'SecurityGroupRules[?IsEgress==`false`]' --output json)

  local legacy_ids=()
  while IFS= read -r id; do
    [[ -n "$id" ]] && legacy_ids+=("$id")
  done < <(jq -r '.[] |
    select((.PrefixListId != null and (.FromPort == 80 or .FromPort == 443))
           or (.FromPort == 80 and .ToPort == 80)) |
    .SecurityGroupRuleId' <<<"$rules")
  if ((${#legacy_ids[@]})); then
    revoke_rule_ids "$sg_id" "${legacy_ids[@]}"
    info "removed ${#legacy_ids[@]} legacy port-80/prefix-list rule(s)"
  fi

  while IFS= read -r cidr; do
    [[ -n "$cidr" ]] && authorize_cidr_rule "$sg_id" 443 "$cidr" "Cloudflare HTTPS"
  done <<<"$desired"

  rules=$(aws_ ec2 describe-security-group-rules \
    --filters "Name=group-id,Values=${sg_id}" \
    --query 'SecurityGroupRules[?IsEgress==`false` && FromPort==`443` && ToPort==`443`]' \
    --output json)
  local stale_ids=()
  while IFS=$'\t' read -r id protocol cidr; do
    [[ -n "$id" ]] || continue
    if [[ "$protocol" != tcp || -z "$cidr" ]] || ! grep -Fxq -- "$cidr" <<<"$desired"; then
      stale_ids+=("$id")
    fi
  done < <(jq -r '.[] | [.SecurityGroupRuleId, .IpProtocol,
    (.CidrIpv4 // .CidrIpv6 // "")] | @tsv' <<<"$rules")
  if ((${#stale_ids[@]})); then
    revoke_rule_ids "$sg_id" "${stale_ids[@]}"
    info "removed ${#stale_ids[@]} stale HTTPS rule(s)"
  fi
}

# GitHub-hosted runner addresses are large and change frequently, so SSH cannot
# be pinned to one workstation CIDR. The host compensates by accepting public
# keys only (02-bootstrap-box.sh installs and validates that sshd policy).
sync_public_key_ssh_rule() {
  local sg_id="$1" rules id cidr protocol
  authorize_cidr_rule "$sg_id" 22 '0.0.0.0/0' 'Key-only SSH (GitHub Actions + admin)'
  rules=$(aws_ ec2 describe-security-group-rules \
    --filters "Name=group-id,Values=${sg_id}" \
    --query 'SecurityGroupRules[?IsEgress==`false` && FromPort==`22` && ToPort==`22`]' \
    --output json)
  local stale_ids=()
  while IFS=$'\t' read -r id protocol cidr; do
    [[ -n "$id" ]] || continue
    [[ "$protocol" == tcp && "$cidr" == '0.0.0.0/0' ]] || stale_ids+=("$id")
  done < <(jq -r '.[] | [.SecurityGroupRuleId, .IpProtocol,
    (.CidrIpv4 // "")] | @tsv' <<<"$rules")
  if ((${#stale_ids[@]})); then
    revoke_rule_ids "$sg_id" "${stale_ids[@]}"
    info "removed ${#stale_ids[@]} stale SSH rule(s)"
  fi
}

# After the desired 22 and 443 rules exist, remove every other ingress path so
# old app-port, all-traffic, and hand-added rules cannot silently bypass Caddy.
prune_unmanaged_ingress_rules() {
  local sg_id="$1" v4="$2" v6="$3" desired rules id cidr protocol from_port to_port
  desired=$(printf '%s\n%s\n' "$v4" "$v6" | grep -v '^$' | sort -u)
  rules=$(aws_ ec2 describe-security-group-rules \
    --filters "Name=group-id,Values=${sg_id}" \
    --query 'SecurityGroupRules[?IsEgress==`false`]' --output json)
  local stale_ids=()
  while IFS=$'\t' read -r id protocol from_port to_port cidr; do
    [[ -n "$id" ]] || continue
    if [[ "$protocol" == tcp && "$from_port" == 22 && "$to_port" == 22 \
          && "$cidr" == '0.0.0.0/0' ]]; then
      continue
    fi
    if [[ "$protocol" == tcp && "$from_port" == 443 && "$to_port" == 443 \
          && -n "$cidr" ]] && grep -Fxq -- "$cidr" <<<"$desired"; then
      continue
    fi
    stale_ids+=("$id")
  done < <(jq -r '.[] | [.SecurityGroupRuleId, .IpProtocol,
    (.FromPort // -1), (.ToPort // -1),
    (.CidrIpv4 // .CidrIpv6 // "")] | @tsv' <<<"$rules")
  if ((${#stale_ids[@]})); then
    revoke_rule_ids "$sg_id" "${stale_ids[@]}"
    warn "removed ${#stale_ids[@]} unmanaged ingress rule(s) from ${sg_id}"
  fi
}

# ---- state -----------------------------------------------------------------
# 01 writes what it created; later scripts read it so you never retype an
# instance id or IP.
STATE_FILE="${SCRIPT_DIR}/.state.env"

state_set() {
  local key="$1" value="$2"
  touch "$STATE_FILE"; chmod 600 "$STATE_FILE"
  grep -v "^${key}=" "$STATE_FILE" > "${STATE_FILE}.tmp" 2>/dev/null || true
  printf '%s=%q\n' "$key" "$value" >> "${STATE_FILE}.tmp"
  mv "${STATE_FILE}.tmp" "$STATE_FILE"
}

state_unset() {
  [[ -f "$STATE_FILE" ]] || return 0
  local key
  for key in "$@"; do
    grep -v "^${key}=" "$STATE_FILE" > "${STATE_FILE}.tmp" || true
    mv "${STATE_FILE}.tmp" "$STATE_FILE"
  done
  chmod 600 "$STATE_FILE"
}

load_state() {
  [[ -f "$STATE_FILE" ]] || return 0
  set -a
  # shellcheck disable=SC1090
  source "$STATE_FILE"
  set +a
}

# ---- driving the box from your laptop --------------------------------------
#
# Only 02 runs on the box itself. Everything else runs here and reaches over
# SSH, which keeps the AWS admin credentials and the CloudFront private key on
# your machine instead of copying them onto an internet-facing host.

require_box() {
  load_state
  [[ -n "${PUBLIC_IP:-}" ]] || die "no PUBLIC_IP in scripts/.state.env — run 01-provision-ec2.sh first"
  [[ -f "${EC2_KEY_FILE}" ]] || die "missing SSH key ${EC2_KEY_FILE}"
}

# Re-reads the public IP from AWS. Without an Elastic IP a stop/start changes
# it, and a stale .state.env would otherwise send every later script to an
# address that is no longer ours.
refresh_public_ip() {
  [[ -n "${INSTANCE_ID:-}" ]] || return 0
  local ip
  ip=$(aws_ ec2 describe-instances --instance-ids "$INSTANCE_ID" \
        --query 'Reservations[0].Instances[0].PublicIpAddress' --output text 2>/dev/null || true)
  if [[ -n "$ip" && "$ip" != "None" && "$ip" != "${PUBLIC_IP:-}" ]]; then
    warn "public IP changed: ${PUBLIC_IP:-none} -> ${ip}"
    PUBLIC_IP="$ip"; state_set PUBLIC_IP "$ip"
  fi
}

box_ssh() {
  ssh -i "$EC2_KEY_FILE" -o StrictHostKeyChecking=accept-new \
      "${EC2_USER}@${PUBLIC_IP}" "$@"
}

box_scp() {
  scp -q -i "$EC2_KEY_FILE" -o StrictHostKeyChecking=accept-new "$@"
}

box_at() { printf '%s@%s' "$EC2_USER" "$PUBLIC_IP"; }
