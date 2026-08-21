#!/usr/bin/env bash
# ============================================================================
# 05 — Point the Cloudflare records at the box, and install the DDNS updater
#      that keeps them pointed there.
#
# WHERE: your laptop.
# TIME:  ~1 minute.
#
#   ./scripts/05-cloudflare-dns.sh dev
#   ./scripts/05-cloudflare-dns.sh prod
#   ./scripts/05-cloudflare-dns.sh both
#
# Creates the selected proxied A record(s), then installs a systemd timer on
# the box that re-points exactly those records whenever the instance's public
# address changes. Start with dev during recovery; rerun with both only after
# production is ready for cutover.
#
# Both records stay proxied (orange cloud). That is load-bearing, not cosmetic:
#   - the origin address never appears in public DNS, so scanners have nothing
#     to correlate the open 443 with;
#   - Cloudflare overwrites CF-Connecting-IP on every request it proxies, which
#     is what makes clientIp() in src/lib/rate-limit.ts trustworthy. A grey-cloud
#     record would let any client forge that header and scatter its login
#     attempts across unlimited rate-limit buckets.
# ============================================================================

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_config
need_cmd curl jq ssh scp
require_box
refresh_public_ip
require_vars CF_ZONE CF_API_TOKEN PROD_HOST DEV_HOST

TARGET="${1:-both}"
case "$TARGET" in
  dev)  TARGET_HOSTS=("$DEV_HOST") ;;
  prod) TARGET_HOSTS=("$PROD_HOST") ;;
  both) TARGET_HOSTS=("$PROD_HOST" "$DEV_HOST") ;;
  *) die "usage: $0 <dev|prod|both>" ;;
esac

step "Cloudflare zone"
ZONE_ID=$(cf_zone_id)
ok "${CF_ZONE} -> ${ZONE_ID}"
state_set CF_ZONE_ID "$ZONE_ID"

upsert_a_record() {
  local host="$1" resp rec_id current
  resp=$(cf_api GET "/zones/${ZONE_ID}/dns_records?type=A&name=${host}")
  cf_check "$resp" "list A records for ${host}"
  rec_id=$(jq -r '.result[0].id // empty' <<<"$resp")
  current=$(jq -r '.result[0].content // empty' <<<"$resp")

  local body
  body=$(jq -n --arg name "$host" --arg ip "$PUBLIC_IP" \
    '{type:"A", name:$name, content:$ip, ttl:1, proxied:true}')

  if [[ -z "$rec_id" ]]; then
    resp=$(cf_api POST "/zones/${ZONE_ID}/dns_records" "$body")
    cf_check "$resp" "create A ${host}"
    ok "created ${host} -> ${PUBLIC_IP} (proxied)"
  elif [[ "$current" != "$PUBLIC_IP" ]]; then
    resp=$(cf_api PUT "/zones/${ZONE_ID}/dns_records/${rec_id}" "$body")
    cf_check "$resp" "update A ${host}"
    ok "updated ${host}: ${current} -> ${PUBLIC_IP}"
  else
    # Still re-assert proxied, in case someone greyed it out in the dashboard.
    resp=$(cf_api PUT "/zones/${ZONE_ID}/dns_records/${rec_id}" "$body")
    cf_check "$resp" "update A ${host}"
    ok "${host} already ${PUBLIC_IP} (proxy re-asserted)"
  fi
}

step "DNS records"
for target_host in "${TARGET_HOSTS[@]}"; do
  upsert_a_record "$target_host"
done

# ---------------------------------------------------------------------------
step "Installing the DDNS updater on the box"
# ---------------------------------------------------------------------------
DDNS=$(mktemp); UNIT=$(mktemp); TIMER=$(mktemp); ENVF=$(mktemp)
trap 'rm -f "$DDNS" "$UNIT" "$TIMER" "$ENVF"' EXIT

cat > "$DDNS" <<'DDNS_EOF'
#!/usr/bin/env bash
# Keeps Cloudflare A records pointed at this box's current public address.
# Installed by scripts/05-cloudflare-dns.sh. Config: /etc/talent-ddns.env
set -euo pipefail

# shellcheck disable=SC1091
source /etc/talent-ddns.env

# Ask Cloudflare what address it sees us from. Using their endpoint rather than
# a third-party "what is my IP" service keeps the dependency list identical to
# the one we already trust for DNS, and it reports the address as the network
# actually presents it.
current=$(curl -fsS --max-time 10 https://cloudflare.com/cdn-cgi/trace | awk -F= '/^ip=/{print $2}')
[[ -n "$current" ]] || { echo "could not determine public IP" >&2; exit 1; }

cf() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-fsS -X "$method"
    -H "Authorization: Bearer ${CF_API_TOKEN}"
    -H "Content-Type: application/json")
  # Built as an array, not interpolated: an unquoted ${3:+--data "$3"} would
  # word-split the JSON body on its spaces and send a truncated request.
  if [[ -n "$body" ]]; then args+=(--data "$body"); fi
  curl "${args[@]}" "https://api.cloudflare.com/client/v4${path}"
}

changed=0
IFS=' ' read -r -a hosts <<<"$HOSTS"
for host in "${hosts[@]}"; do
  resp=$(cf GET "/zones/${CF_ZONE_ID}/dns_records?type=A&name=${host}")
  if [[ "$(jq -r '.success' <<<"$resp")" != true ]]; then
    echo "failed to list A record for $host" >&2
    jq -r '.errors[]? | "[\(.code)] \(.message)"' <<<"$resp" >&2
    exit 1
  fi
  rec_id=$(jq -r '.result[0].id // empty' <<<"$resp")
  content=$(jq -r '.result[0].content // empty' <<<"$resp")
  proxied=$(jq -r '.result[0].proxied // false' <<<"$resp")

  body=$(jq -n --arg name "$host" --arg ip "$current" \
    '{type:"A", name:$name, content:$ip, ttl:1, proxied:true}')

  if [[ -z "$rec_id" ]]; then
    result=$(cf POST "/zones/${CF_ZONE_ID}/dns_records" "$body")
    action="created"
  elif [[ "$content" != "$current" || "$proxied" != true ]]; then
    result=$(cf PUT "/zones/${CF_ZONE_ID}/dns_records/${rec_id}" "$body")
    action="updated"
  else
    continue
  fi

  if jq -e '.success == true' >/dev/null <<<"$result"; then
    logger -t talent-ddns "${action} ${host}: ${content:-missing} -> ${current} (proxied)"
    echo "${action} ${host}: ${content:-missing} -> ${current} (proxied)"
    changed=1
  else
    echo "failed to ${action} ${host}" >&2
    jq -r '.errors[]? | "[\(.code)] \(.message)"' <<<"$result" >&2
    exit 1
  fi
done

# Every run reads both records even when the IP is unchanged. That is what lets
# the timer recreate a deleted record and re-enable the proxy if someone turns
# it off in the dashboard; caching only the last IP made both failures sticky.
if [[ "$changed" == 1 ]]; then logger -t talent-ddns "public IP is now ${current}"; fi
exit 0
DDNS_EOF

# Quoted: this file is `source`d by bash, so an unquoted multi-word HOSTS would
# parse as an assignment followed by a command named after the second host.
cat > "$ENVF" <<EOF
CF_API_TOKEN="${CF_API_TOKEN}"
CF_ZONE_ID="${ZONE_ID}"
HOSTS="${TARGET_HOSTS[*]}"
EOF

cat > "$UNIT" <<'EOF'
[Unit]
Description=Update Cloudflare DNS with this host's public address
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/talent-ddns.sh
# The token is a file the service reads as root; it is never an argument, so it
# does not appear in `ps` or in the journal.
User=root
EOF

cat > "$TIMER" <<'EOF'
[Unit]
Description=Run the Cloudflare DDNS updater every 5 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
EOF

box_scp "$DDNS"  "$(box_at):/tmp/talent-ddns.sh"
box_scp "$ENVF"  "$(box_at):/tmp/talent-ddns.env"
box_scp "$UNIT"  "$(box_at):/tmp/talent-ddns.service"
box_scp "$TIMER" "$(box_at):/tmp/talent-ddns.timer"

box_ssh bash -s <<'REMOTE'
set -euo pipefail
sudo install -m 755 /tmp/talent-ddns.sh /usr/local/bin/talent-ddns.sh
sudo install -m 600 -o root -g root /tmp/talent-ddns.env /etc/talent-ddns.env
sudo install -m 644 /tmp/talent-ddns.service /etc/systemd/system/talent-ddns.service
sudo install -m 644 /tmp/talent-ddns.timer   /etc/systemd/system/talent-ddns.timer
rm -f /tmp/talent-ddns.*
sudo systemctl daemon-reload
sudo systemctl enable --now talent-ddns.timer
sudo systemctl start talent-ddns.service
REMOTE
ok "timer installed and fired once"

box_ssh "systemctl list-timers talent-ddns.timer --no-pager | head -3"

cat <<EOF

${c_green}DNS ready.${c_reset}

  target ${TARGET}: ${TARGET_HOSTS[*]} -> ${PUBLIC_IP}  (proxied)

${c_yellow}One manual step in the Cloudflare dashboard${c_reset} — the API token deliberately
lacks Zone Settings permission, so these cannot be scripted with it:

  SSL/TLS > Overview        set encryption mode to ${c_green}Full (Strict)${c_reset}
  SSL/TLS > Edge Certs      turn on "Always Use HTTPS"

Full (Strict) is what makes Cloudflare verify the origin certificate Caddy
presents. Flexible or Full (non-strict) would leave the Cloudflare-to-origin
hop unauthenticated, which defeats the point of terminating TLS here at all.

Next: ./06-caddy-up.sh
EOF
