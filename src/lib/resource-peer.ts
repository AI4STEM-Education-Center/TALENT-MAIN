import crypto from "node:crypto";
import type { ResourceRange } from "./resource-metrics";
import type { ResourceNodeSeries } from "./resource-monitor";

// Cross-deployment link for the admin resource monitor.
//
// Prod and dev are independent deployments with independent databases, so
// neither can see the other's samples by querying its own tables. Rather than
// give one environment write access to the other's database (or funnel both
// through a shared metrics store), each side keeps serving its own numbers and
// the admin page asks its peer for the rest over HTTPS:
//
//   dev  /api/admin/resources  ->  prod /api/internal/resource-samples
//   prod /api/admin/resources  ->  dev  /api/internal/resource-samples
//
// The peer link is authenticated by RESOURCE_MONITOR_TOKEN, which both
// deployments share, and is entirely optional: with it unset (or the peer
// down) each environment still charts its own two nodes and the page labels
// the others "unreachable".

const PEER_TIMEOUT_MS = 6000;
const PEER_CACHE_TTL_MS = 15_000;

export interface PeerStatus {
  configured: boolean;
  ok: boolean;
  url: string | null;
  error: string | null;
}

/** Peer base URL + shared token, or null when this deployment has no peer configured. */
export function peerConfig(): { url: string; token: string } | null {
  const url = process.env.RESOURCE_MONITOR_PEER_URL?.trim();
  const token = process.env.RESOURCE_MONITOR_TOKEN?.trim();
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

/**
 * Constant-time check of an incoming peer request's bearer token.
 *
 * Both sides are hashed first so the comparison length never depends on the
 * secret (timingSafeEqual throws on a length mismatch, which would itself leak
 * the token's length). Returns false when no token is configured: an
 * unconfigured deployment must not accept every request.
 */
export function verifyResourceMonitorToken(authorization: string | null): boolean {
  const expected = process.env.RESOURCE_MONITOR_TOKEN?.trim();
  if (!expected) return false;
  const presented = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  if (!presented) return false;
  return crypto.timingSafeEqual(
    crypto.createHash("sha256").update(presented).digest(),
    crypto.createHash("sha256").update(expected).digest()
  );
}

let cache: { range: ResourceRange; nodes: ResourceNodeSeries[]; status: PeerStatus; at: number } | null =
  null;

/**
 * The peer environment's node series, or an empty list plus a reason.
 *
 * Never throws: the peer being down is a normal, displayable state, not an
 * error that should blank out the local numbers too.
 */
export async function fetchPeerNodes(
  range: ResourceRange
): Promise<{ nodes: ResourceNodeSeries[]; status: PeerStatus }> {
  const config = peerConfig();
  if (!config) {
    return {
      nodes: [],
      status: { configured: false, ok: false, url: null, error: null },
    };
  }

  const now = Date.now();
  if (cache && cache.range === range && now - cache.at < PEER_CACHE_TTL_MS) {
    return { nodes: cache.nodes, status: cache.status };
  }

  const status: PeerStatus = { configured: true, ok: false, url: config.url, error: null };
  let nodes: ResourceNodeSeries[] = [];

  try {
    const response = await fetch(
      `${config.url}/api/internal/resource-samples?range=${encodeURIComponent(range)}`,
      {
        headers: { Authorization: `Bearer ${config.token}` },
        cache: "no-store",
        signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
      }
    );
    if (!response.ok) {
      status.error = `Peer responded ${response.status}`;
    } else {
      const body = (await response.json()) as { nodes?: ResourceNodeSeries[] };
      nodes = Array.isArray(body.nodes) ? body.nodes : [];
      status.ok = true;
    }
  } catch (err: unknown) {
    status.error =
      err instanceof Error
        ? err.name === "TimeoutError"
          ? `Peer did not respond within ${PEER_TIMEOUT_MS}ms`
          : err.message
        : "Peer request failed";
  }

  cache = { range, nodes, status, at: now };
  return { nodes, status };
}
