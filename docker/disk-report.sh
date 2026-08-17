#!/usr/bin/env bash
# Break down what is using the EC2 root volume.
#
#   scp docker/disk-report.sh <ec2>:~/ && ssh <ec2> 'bash ~/disk-report.sh'
#
# The admin System Resources tab shows how full the disk is and how much of it
# is the application's own data, but it cannot see the rest: the app containers
# run as an unprivileged user and /var/lib/docker is not readable from inside
# them. This is the other half — run it on the host when the tab says the disk
# is filling up and the app's own footprint does not explain it.
#
# Read-only: it measures and prints, and the cleanup commands at the end are
# printed for you to run, not executed. Some paths need root to traverse, so
# without sudo a few sections report less than the whole truth.
set -uo pipefail

SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

heading() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

heading "Filesystem"
df -h / /var 2>/dev/null | sort -u

heading "Largest top-level directories"
# One level deep first: this is the "which neighbourhood" question. --one-file-system
# keeps it off /proc, /sys and any other mount.
$SUDO du -h --max-depth=1 --one-file-system / 2>/dev/null | sort -rh | head -15

heading "Docker disk usage"
docker system df 2>/dev/null || echo "docker not available to this user"

heading "Docker images, newest first"
docker images --format '{{.Size}}\t{{.CreatedSince}}\t{{.Repository}}:{{.Tag}}' 2>/dev/null |
  sort -rh | head -20

heading "Container log files"
# The classic runaway on a long-lived box: the json-file driver keeps logs
# forever unless max-size is set. Both compose files now set it, but the limit
# only applies to containers created after that change was deployed — anything
# older is still whatever size it grew to.
$SUDO sh -c '
  total=0
  for log in /var/lib/docker/containers/*/*-json.log; do
    [ -f "$log" ] || continue
    size=$(stat -c %s "$log")
    total=$((total + size))
    id=$(basename "$(dirname "$log")")
    name=$(docker inspect --format "{{.Name}}" "$id" 2>/dev/null | sed "s|^/||")
    printf "%12s  %s\n" "$(numfmt --to=iec "$size")" "${name:-$id}"
  done | sort -rh
  printf "%12s  TOTAL\n" "$(numfmt --to=iec "$total")"
' 2>/dev/null || echo "need root to read /var/lib/docker/containers"

heading "Application data (~/app/data)"
du -sh ~/app/data/* 2>/dev/null | sort -rh

heading "Resource monitor spool"
docker volume inspect talent-resource-metrics --format '{{.Mountpoint}}' 2>/dev/null |
  while read -r mount; do $SUDO du -sh "$mount" 2>/dev/null; done

heading "System logs"
journalctl --disk-usage 2>/dev/null || echo "journalctl not available"
$SUDO du -sh /var/log 2>/dev/null

heading "Package and kernel leftovers"
$SUDO du -sh /var/cache/apt /var/lib/apt /snap /var/lib/snapd 2>/dev/null | sort -rh
# Ubuntu keeps every kernel it has ever installed unless autoremove runs; on a
# 20 GB volume a year of them is measured in gigabytes.
echo "installed kernels:"
ls -1 /boot/vmlinuz-* 2>/dev/null | wc -l
$SUDO du -sh /boot /usr/lib/modules 2>/dev/null

heading "Largest individual files (>100M)"
$SUDO find / -xdev -type f -size +100M -printf '%s\t%p\n' 2>/dev/null |
  sort -rn | head -20 |
  while IFS=$'\t' read -r size file; do printf "%12s  %s\n" "$(numfmt --to=iec "$size")" "$file"; done

cat <<'EOF'

== Cleanup, in increasing order of aggressiveness ==
Nothing below has been run. Read the numbers above first — the point is to
delete what is actually large, not to run all of these.

  # Images and stopped containers nothing is using (keeps what is running):
  docker container prune -f
  docker image prune -af --filter "until=168h"
  docker builder prune -f

  # Truncate oversized container logs in place. Safe on a running container —
  # the daemon holds the fd and keeps appending — but it discards history, so
  # check the log first if you are mid-incident.
  sudo sh -c 'truncate -s 0 /var/lib/docker/containers/*/*-json.log'

  # Cap journald (it defaults to 10% of the filesystem):
  sudo journalctl --vacuum-size=200M

  # Old kernels and package caches:
  sudo apt-get autoremove --purge -y && sudo apt-get clean

  # Last resort, and only when you have read what it would remove: this also
  # deletes unused VOLUMES, which on this box includes talent-resource-metrics
  # if both stacks happen to be down. Prefer the targeted commands above.
  docker system prune -a --volumes
EOF
