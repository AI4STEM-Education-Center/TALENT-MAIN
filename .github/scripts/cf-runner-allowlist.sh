#!/usr/bin/env bash
# Temporarily allowlist this GitHub Actions runner's IP on the ai4talent.org
# Cloudflare zone so the live-site API checks can reach dev/prod.
#
# Why: the zone runs Cloudflare Bot Fight Mode (Free plan), which answers
# requests from datacenter IPs such as GitHub's runners with a 403 "Just a
# moment..." challenge. Bot Fight Mode cannot be skipped by WAF custom rules or
# Page Rules; a zone IP Access "whitelist" rule matching the connecting IP is
# the only per-client exemption. The rule exists only for the duration of the
# job: `add` creates it, `remove` (run with `if: always()`) deletes it, and
# `add` also sweeps rules left behind by runs that were killed before cleanup.
#
# Usage: cf-runner-allowlist.sh add|remove
# Env:   CLOUDFLARE_API_TOKEN  token with Zone > Firewall Services > Edit on the zone
#        CLOUDFLARE_ZONE_ID    the ai4talent.org zone
#        ALLOWLIST_PROBE_URL   (add) URL to poll until it stops returning 403
#        CF_ALLOWLIST_RULE_ID  (remove) set by `add` through $GITHUB_ENV
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ZONE_ID:?CLOUDFLARE_ZONE_ID is required}"

API="https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/firewall/access_rules/rules"
MARKER="github-actions-runner-allowlist"
STALE_AFTER_SECONDS=$((2 * 60 * 60))

cf() {
  curl -sS --retry 3 --retry-all-errors -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" "$@"
}

sweep_stale() {
  local now cutoff ids
  now=$(date -u +%s)
  cutoff=$((now - STALE_AFTER_SECONDS))
  ids=$(cf "${API}?per_page=100&notes=${MARKER}" | jq -r --argjson cutoff "$cutoff" --arg marker "$MARKER" '
    .result[]? | select((.notes // "") | startswith($marker))
    | select((.created_on | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) < $cutoff) | .id')
  for id in $ids; do
    echo "Removing stale runner allowlist rule ${id}"
    cf -X DELETE "${API}/${id}" >/dev/null || true
  done
}

add() {
  local ip body response rule_id
  ip=$(curl -4 -fsS --retry 3 https://api.ipify.org)
  echo "Runner IPv4: ${ip}"
  sweep_stale

  body=$(jq -n --arg ip "$ip" --arg notes "${MARKER} run ${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1} ${GITHUB_WORKFLOW:-}" \
    '{mode: "whitelist", configuration: {target: "ip", value: $ip}, notes: $notes}')
  response=$(cf -X POST "$API" --data "$body")
  rule_id=$(jq -r 'if .success then .result.id else empty end' <<<"$response")
  if [ -z "$rule_id" ]; then
    # Another job on the same IP may already own a rule; reuse it without
    # taking ownership so that job's cleanup stays authoritative.
    if cf "${API}?configuration.target=ip&configuration.value=${ip}" |
      jq -e '.result | length > 0' >/dev/null; then
      echo "An allowlist rule for ${ip} already exists; reusing it."
    else
      echo "Failed to create Cloudflare allowlist rule:" >&2
      jq -c '.errors' <<<"$response" >&2
      exit 1
    fi
  else
    echo "Created allowlist rule ${rule_id}"
    [ -n "${GITHUB_ENV:-}" ] && echo "CF_ALLOWLIST_RULE_ID=${rule_id}" >>"$GITHUB_ENV"
  fi

  # IP Access rules propagate across the edge within seconds; wait until the
  # challenge stops so the first check doesn't race it.
  if [ -n "${ALLOWLIST_PROBE_URL:-}" ]; then
    local status
    for _ in $(seq 1 24); do
      status=$(curl -4 -s -o /dev/null -w '%{http_code}' -A "node" "$ALLOWLIST_PROBE_URL" || true)
      if [ "$status" != "403" ] && [ "$status" != "000" ]; then
        echo "Probe ${ALLOWLIST_PROBE_URL} -> ${status}"
        return 0
      fi
      sleep 5
    done
    echo "Probe ${ALLOWLIST_PROBE_URL} still returned ${status} after 2 minutes" >&2
    exit 1
  fi
}

remove() {
  if [ -z "${CF_ALLOWLIST_RULE_ID:-}" ]; then
    echo "No allowlist rule owned by this job; nothing to remove."
    return 0
  fi
  cf -X DELETE "${API}/${CF_ALLOWLIST_RULE_ID}" | jq -e '.success' >/dev/null
  echo "Removed allowlist rule ${CF_ALLOWLIST_RULE_ID}"
}

case "${1:-}" in
  add) add ;;
  remove) remove ;;
  *)
    echo "usage: $0 add|remove" >&2
    exit 2
    ;;
esac
