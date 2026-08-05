#!/usr/bin/env bash
#
# Install a pinned, checksum-verified k6.
#
# One implementation, used by CI and by the EC2 load generator, for two reasons:
#
#   1. Trust. This downloads a binary and puts it on PATH. Doing that without
#      verifying a digest means a corrupted transfer, a compromised mirror, or a
#      substituted asset all install silently. K6_SHA256 pins the exact expected
#      digest; without it, the release's own signed-over-TLS checksums file is
#      used, which still catches corruption and asset substitution.
#   2. Comparability. k6's scheduling and metric internals change between
#      releases, so an unpinned tool quietly invalidates every stored baseline.
#      The version is recorded in each run manifest for the same reason.
#
# Usage: install-k6.sh [--version 1.4.1] [--prefix /usr/local/bin]
# Env:   K6_VERSION, K6_SHA256 (optional, strongest), K6_PREFIX

set -euo pipefail

VERSION="${K6_VERSION:-2.1.0}"
PREFIX="${K6_PREFIX:-/usr/local/bin}"
EXPECTED_SHA="${K6_SHA256:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --sha256) EXPECTED_SHA="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

case "$(uname -m)" in
  x86_64|amd64) ARCH="linux-amd64" ;;
  aarch64|arm64) ARCH="linux-arm64" ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

if command -v k6 >/dev/null 2>&1 && k6 version 2>/dev/null | grep -q "v${VERSION}"; then
  echo "k6 v${VERSION} already installed"
  exit 0
fi

ASSET="k6-v${VERSION}-${ARCH}.tar.gz"
BASE="https://github.com/grafana/k6/releases/download/v${VERSION}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "downloading ${ASSET}"
curl -fsSL --proto '=https' --tlsv1.2 "${BASE}/${ASSET}" -o "${WORK}/${ASSET}"

sha_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
ACTUAL_SHA="$(sha_of "${WORK}/${ASSET}")"

if [[ -n "$EXPECTED_SHA" ]]; then
  if [[ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
    echo "CHECKSUM MISMATCH — refusing to install" >&2
    echo "  expected: $EXPECTED_SHA" >&2
    echo "  actual:   $ACTUAL_SHA" >&2
    exit 1
  fi
  echo "digest verified against the pinned K6_SHA256"
else
  # Fall back to the release's published checksums. Weaker than a pinned digest
  # (same origin as the asset), but it still detects a truncated download or a
  # replaced asset, and it fails loudly rather than trusting silently.
  echo "no K6_SHA256 pinned — verifying against the release checksums file"
  if curl -fsSL --proto '=https' --tlsv1.2 \
      "${BASE}/k6-v${VERSION}-checksums.txt" -o "${WORK}/checksums.txt"; then
    if ! grep -q "$ACTUAL_SHA" "${WORK}/checksums.txt"; then
      echo "CHECKSUM MISMATCH against the published checksums — refusing to install" >&2
      echo "  actual: $ACTUAL_SHA" >&2
      exit 1
    fi
    echo "digest matches the published checksums"
  else
    echo "WARNING: could not fetch the checksums file; installing unverified." >&2
    echo "         Pin K6_SHA256=$ACTUAL_SHA to make this deterministic." >&2
  fi
fi

tar -xzf "${WORK}/${ASSET}" -C "$WORK"
BINARY="${WORK}/k6-v${VERSION}-${ARCH}/k6"
[[ -f "$BINARY" ]] || { echo "archive did not contain the expected binary" >&2; exit 1; }

if [[ -w "$PREFIX" ]]; then
  install -m 0755 "$BINARY" "${PREFIX}/k6"
else
  sudo install -m 0755 "$BINARY" "${PREFIX}/k6"
fi

"${PREFIX}/k6" version
echo "k6 v${VERSION} installed (sha256 ${ACTUAL_SHA})"
