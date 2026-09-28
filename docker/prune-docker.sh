#!/usr/bin/env bash
# ============================================================================
# Reclaim Docker disk on the deploy host.
#
# WHERE: the box. Both deploy workflows scp this next to docker-compose.yml and
#        run it at the end of a deploy, and docker-prune.yml runs it on a
#        schedule so a quiet week or a deploy that failed before this point
#        still gets swept.
#
#   bash prune-docker.sh [--dry-run]
#
# Why not `docker image prune -af --filter until=<age>`, which is what the
# deploy workflows used to run: the box uses the containerd image store, where
# that filter is measured against the containerd image *record*, not the date
# the image was built. Superseding a tag does not delete the old image, it
# re-registers it as `moby-dangling@sha256:...` — a record created by the very
# pull that displaced it. The prune runs seconds later, sees a record seconds
# old, and keeps it. Every deploy logged "Total reclaimed space: 0B" while ten
# untagged 800 MB images accumulated. Age is not a usable signal here, so this
# bounds the count instead: whatever is running is kept, one rollback
# generation is kept, everything else goes.
# ============================================================================
set -euo pipefail

# Unreferenced images to retain, newest first. 2 covers a rollback of prod and
# of dev without a re-pull. Anything beyond it is a deploy nobody can reach.
KEEP_UNTAGGED="${KEEP_UNTAGGED:-2}"
BUILD_CACHE_MAX="${BUILD_CACHE_MAX:-2GB}"

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

disk() { df -h --output=pcent,used,avail / | tail -1 | tr -s ' '; }

before=$(disk)
echo "before:${before}"

$DRY_RUN || docker container prune -f >/dev/null

# Images a container still points at. A container records both a resolved image
# id and the reference it was started from, and on a digest-pinned deploy those
# resolve to two different image records — protect both.
held=$'\n'
for c in $(docker ps -aq); do
  held+="$(docker inspect -f '{{.Image}}' "$c")"$'\n'
  ref=$(docker inspect -f '{{.Config.Image}}' "$c")
  if id=$(docker image inspect "$ref" -f '{{.Id}}' 2>/dev/null); then
    held+="${id}"$'\n'
  fi
done

candidates=()
while read -r id; do
  [[ "$held" == *$'\n'"${id}"$'\n'* ]] && continue

  meta=$(docker image inspect "$id" -f '{{.Created}}|{{join .RepoTags ","}}' 2>/dev/null) || continue
  created=${meta%%|*}

  # A `name@sha256:...` entry is a digest pin, not a tag anyone chose. A real
  # name:tag is: it may be a locally built image with no registry to re-pull it
  # from (talent-caddy:local), so a named image is never a candidate.
  named=false
  IFS=',' read -ra refs <<< "${meta#*|}"
  for r in "${refs[@]}"; do
    [[ -n "$r" && "$r" != *"@sha256:"* ]] && named=true
  done
  $named && continue

  candidates+=("${created} ${id}")
done < <(docker images -aq --no-trunc | sort -u)

echo "unreferenced:${#candidates[@]} keep:${KEEP_UNTAGGED}"

if ((${#candidates[@]} > KEEP_UNTAGGED)); then
  while read -r created id; do
    if $DRY_RUN; then
      echo "  would remove ${id} (built ${created})"
    elif docker rmi "$id" >/dev/null 2>&1; then
      echo "  removed ${id} (built ${created})"
    else
      # Left in place on purpose: something still depends on it, and the next
      # sweep will pick it up once that goes away.
      echo "  in use, kept ${id}"
    fi
  done < <(printf '%s\n' "${candidates[@]}" | sort -r | tail -n +$((KEEP_UNTAGGED + 1)))
fi

# Build-cache records carry an honest creation time, so a cap works here.
$DRY_RUN || docker builder prune -af --max-used-space "$BUILD_CACHE_MAX" >/dev/null

after=$(disk)
echo "after:${after}"
