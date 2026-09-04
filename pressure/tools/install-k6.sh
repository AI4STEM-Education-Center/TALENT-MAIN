#!/usr/bin/env bash
#
# Install a PINNED, checksum-verified k6.
#
# Shared by CI and the EC2 load generator on purpose: k6's own version affects
# measured numbers (executor scheduling, HTTP client defaults, metric
# aggregation), so two tiers running different k6 builds cannot be compared, and
# a `latest` install silently invalidates every stored baseline the day upstream
# cuts a release.
#
# The checksum is verified because this binary is what generates the numbers a
# capacity decision gets made on.
set -euo pipefail

K6_VERSION="${K6_VERSION:-2.1.0}"
PREFIX="/usr/local/bin"

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --version) K6_VERSION="$2"; shift 2 ;;
    -h|--help) echo "usage: install-k6.sh [--version 2.1.0] [--prefix /usr/local/bin]"; exit 0 ;;
    *) echo "install-k6: unknown argument: $1" >&2; exit 1 ;;
  esac
done

case "$(uname -s)" in
  Linux)  OS="linux" ;;
  Darwin) OS="macos" ;;
  *) echo "install-k6: unsupported OS $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH="amd64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "install-k6: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

# Already the right version? Do nothing — this runs on every loadgen boot and on
# every CI job, and a no-op is much faster than a re-download.
if command -v k6 >/dev/null 2>&1 && k6 version 2>/dev/null | grep -q "v${K6_VERSION}"; then
  echo "install-k6: k6 v${K6_VERSION} is already installed"
  exit 0
fi

TARBALL="k6-v${K6_VERSION}-${OS}-${ARCH}.tar.gz"
BASE_URL="https://github.com/grafana/k6/releases/download/v${K6_VERSION}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "install-k6: downloading ${TARBALL}..."
curl --retry 5 --retry-all-errors --connect-timeout 15 -fsSL \
  "${BASE_URL}/${TARBALL}" -o "${WORK}/${TARBALL}"

# k6 publishes one checksums file per release. Verify against it rather than
# against a hash pinned in this repo: a pinned hash would have to be updated by
# hand for every OS/arch pair, and a stale one fails in a way that tempts people
# to just delete the check.
if curl --retry 5 --retry-all-errors --connect-timeout 15 -fsSL \
  "${BASE_URL}/k6-v${K6_VERSION}-checksums.txt" -o "${WORK}/checksums.txt" 2>/dev/null; then
  EXPECTED="$(grep " ${TARBALL}\$" "${WORK}/checksums.txt" | awk '{print $1}' | head -1)"
  if [ -n "$EXPECTED" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      ACTUAL="$(sha256sum "${WORK}/${TARBALL}" | awk '{print $1}')"
    else
      ACTUAL="$(shasum -a 256 "${WORK}/${TARBALL}" | awk '{print $1}')"
    fi
    [ "$EXPECTED" = "$ACTUAL" ] || {
      echo "install-k6: CHECKSUM MISMATCH for ${TARBALL}" >&2
      echo "  expected ${EXPECTED}" >&2
      echo "  actual   ${ACTUAL}" >&2
      exit 1
    }
    echo "install-k6: checksum verified"
  else
    echo "install-k6: WARNING: ${TARBALL} is not listed in the release checksums file" >&2
  fi
else
  echo "install-k6: WARNING: could not fetch the checksums file; the download was NOT verified" >&2
fi

tar -xzf "${WORK}/${TARBALL}" -C "$WORK"
BINARY="$(find "$WORK" -type f -name k6 -perm -u+x | head -1)"
[ -n "$BINARY" ] || { echo "install-k6: no k6 binary inside the tarball" >&2; exit 1; }

mkdir -p "$PREFIX"
install -m 0755 "$BINARY" "${PREFIX}/k6" 2>/dev/null || {
  sudo mkdir -p "$PREFIX"
  sudo install -m 0755 "$BINARY" "${PREFIX}/k6"
}

echo "install-k6: installed $("${PREFIX}/k6" version)"
