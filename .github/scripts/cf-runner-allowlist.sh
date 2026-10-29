#!/usr/bin/env bash
# Temporarily allowlist this GitHub Actions runner's IP on the ai4talent.org
# Cloudflare zone so the live-site API checks can reach dev/prod.
#
# Why: the zone runs Cloudflare Bot Fight Mode (Free plan), which answers
# requests from datacenter IPs such as GitHub's runners with a 403 "Just a
# moment..." challenge. Bot Fight Mode cannot be skipped by WAF custom rules or
# Page Rules; a zone IP Access "whitelist" rule matching the connecting IP is
# the only per-client exemption. Such a rule bypasses the zone's other security
# features for that IP too, so it must be short-lived:
#
# - `add` creates a rule tagged with a per-run marker and exports its id.
#   Cloudflare allows one rule per IP, so if another run already owns a rule
#   for this IP, `add` waits for that run's cleanup instead of sharing it.
# - `remove` (run with `if: always()`) deletes every rule carrying this run's
#   marker, so a rule whose create response was lost is still cleaned up.
# - `sweep` deletes marker rules older than STALE_AFTER_SECONDS; it runs on a
#   schedule (cf-allowlist-sweep.yml) as well as at the start of `add`, so a
#   killed job can't leave an allowance behind indefinitely.
#
# Usage: cf-runner-allowlist.sh add|remove|sweep
# Env:   CLOUDFLARE_API_TOKEN  token with Zone > Firewall Services > Edit on the zone
#        CLOUDFLARE_ZONE_ID    the ai4talent.org zone
#        ALLOWLIST_PROBE_URL   (add) URL to poll until it stops returning 403
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ZONE_ID:?CLOUDFLARE_ZONE_ID is required}"

API="https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/firewall/access_rules/rules"
MARKER="github-actions-runner-allowlist"
RUN_MARKER="${MARKER} run=${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-${GITHUB_JOB:-job}"
STALE_AFTER_SECONDS=$((2 * 60 * 60))
WAIT_FOR_OTHER_RUN_SECONDS=$((20 * 60))

# Prints the response body; never exits non-zero on transport errors so
# callers can reconcile ambiguous outcomes (an empty body means "unknown").
cf() {
  curl -sS --retry 3 --retry-all-errors -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" "$@" || true
}

# Rules matching an exact IPv4 address, as JSON array (exits on API failure).
rules_for_ip() {
  local response
  response=$(cf "${API}?per_page=100&configuration.target=ip&configuration.value=$1")
  jq -e '.success == true' >/dev/null <<<"$response" || {
    echo "Failed to list IP Access rules: $(jq -c '.errors? // .' <<<"$response" 2>/dev/null || echo "$response")" >&2
    exit 1
  }
  jq --arg ip "$1" '[.result[] | select(.configuration.target == "ip" and .configuration.value == $ip)]' <<<"$response"
}

# Ids of rules whose notes contain the given text (exits on API failure).
rule_ids_with_note() {
  local response
  response=$(cf -G "${API}" --data-urlencode "notes=$1" --data "per_page=100")
  jq -e '.success == true' >/dev/null <<<"$response" || {
    echo "Failed to list IP Access rules: $(jq -c '.errors? // .' <<<"$response" 2>/dev/null || echo "$response")" >&2
    exit 1
  }
  jq -r --arg note "$1" '.result[] | select((.notes // "") | contains($note)) | .id' <<<"$response"
}

delete_rule() {
  if cf -X DELETE "${API}/$1" | jq -e '.success == true' >/dev/null 2>&1; then
    echo "Removed allowlist rule $1"
  else
    echo "Failed to remove allowlist rule $1" >&2
    return 1
  fi
}

sweep() {
  local response cutoff ids failed=0
  cutoff=$(($(date -u +%s) - STALE_AFTER_SECONDS))
  response=$(cf -G "${API}" --data-urlencode "notes=${MARKER}" --data "per_page=100")
  jq -e '.success == true' >/dev/null <<<"$response" || {
    echo "Failed to list IP Access rules for sweep" >&2
    return 1
  }
  ids=$(jq -r --argjson cutoff "$cutoff" --arg marker "$MARKER" '
    .result[] | select((.notes // "") | startswith($marker))
    | select((.created_on | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) < $cutoff) | .id' <<<"$response")
  for id in $ids; do
    echo "Sweeping stale runner allowlist rule ${id}"
    delete_rule "$id" || failed=1
  done
  return "$failed"
}

export_owned() {
  echo "Created allowlist rule $1 (${RUN_MARKER})"
  if [ -n "${GITHUB_ENV:-}" ]; then echo "CF_ALLOWLIST_RULE_ID=$1" >>"$GITHUB_ENV"; fi
}

add() {
  local ip body response rule_id existing deadline
  ip=$(curl -4 -fsS --retry 3 https://api.ipify.org)
  echo "Runner IPv4: ${ip}"
  sweep || echo "Warning: stale-rule sweep incomplete; the scheduled sweep will retry." >&2

  body=$(jq -n --arg ip "$ip" --arg notes "${RUN_MARKER} ${GITHUB_WORKFLOW:-}" \
    '{mode: "whitelist", configuration: {target: "ip", value: $ip}, notes: $notes}')
  deadline=$(($(date -u +%s) + WAIT_FOR_OTHER_RUN_SECONDS))
  while :; do
    response=$(cf -X POST "$API" --data "$body")
    rule_id=$(jq -r 'if .success == true then .result.id else empty end' <<<"$response" 2>/dev/null || true)
    if [ -n "$rule_id" ]; then
      export_owned "$rule_id"
      break
    fi

    # Creation failed or its response was lost: reconcile against what exists.
    existing=$(rules_for_ip "$ip")
    rule_id=$(jq -r --arg m "$RUN_MARKER" '.[] | select((.notes // "") | contains($m)) | .id' <<<"$existing" | head -n1)
    if [ -n "$rule_id" ]; then
      export_owned "$rule_id" # our create succeeded despite the error
      break
    fi
    if jq -e 'length == 0' >/dev/null <<<"$existing"; then
      echo "Failed to create Cloudflare allowlist rule: $(jq -c '.errors? // .' <<<"$response" 2>/dev/null || echo "$response")" >&2
      exit 1
    fi
    if jq -e --arg marker "$MARKER" 'any(.[]; (.notes // "") | startswith($marker))' >/dev/null <<<"$existing"; then
      # Another run owns this IP's rule; wait for its cleanup rather than share
      # a rule it may delete while our checks are still running.
      if [ "$(date -u +%s)" -ge "$deadline" ]; then
        echo "Another run's allowlist rule for ${ip} did not clear within $((WAIT_FOR_OTHER_RUN_SECONDS / 60)) minutes" >&2
        exit 1
      fi
      echo "Another run holds an allowlist rule for ${ip}; waiting for it to clear..."
      sleep 15
      continue
    fi
    if jq -e 'any(.[]; .mode == "whitelist")' >/dev/null <<<"$existing"; then
      # A manually managed allow rule already covers this IP: use it, never delete it.
      echo "A non-CI allowlist rule already covers ${ip}; using it without taking ownership."
      break
    fi
    echo "IP ${ip} is covered by a non-allow IP Access rule ($(jq -r '[.[].mode] | join(",")' <<<"$existing")); refusing to continue." >&2
    exit 1
  done

  # IP Access rules propagate across the edge within seconds; wait until the
  # challenge stops so the first check doesn't race it.
  if [ -n "${ALLOWLIST_PROBE_URL:-}" ]; then
    local status=""
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
  local ids failed=0
  # Every rule tagged with this run's marker, which includes CF_ALLOWLIST_RULE_ID
  # and any rule whose create response never reached us.
  ids=$(
    {
      [ -n "${CF_ALLOWLIST_RULE_ID:-}" ] && echo "$CF_ALLOWLIST_RULE_ID"
      rule_ids_with_note "$RUN_MARKER"
    } | sort -u
  )
  if [ -z "$ids" ]; then
    echo "No allowlist rule owned by this job; nothing to remove."
    return 0
  fi
  for id in $ids; do delete_rule "$id" || failed=1; done
  return "$failed"
}

case "${1:-}" in
  add) add ;;
  remove) remove ;;
  sweep) sweep ;;
  *)
    echo "usage: $0 add|remove|sweep" >&2
    exit 2
    ;;
esac
