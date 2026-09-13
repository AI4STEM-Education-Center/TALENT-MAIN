import { logSystemEvent } from "@/lib/system-log";

/**
 * In-memory traffic sampler behind the USAGE rows in the admin system log.
 * The proxy reports every allowed request; once a window is older than
 * WINDOW_MS the next request rolls it over and the finished window is
 * persisted as a "USAGE_SAMPLE" SystemLog row (request count, API share,
 * unique client IPs — the closest thing to a connection count for a
 * cookie-session HTTP app).
 *
 * Like the rate limiter, this is process-local state sized for the current
 * single-instance deployment. Two caveats by design: an idle server writes no
 * rows (nothing to record), and the in-flight window is lost on restart.
 */

const WINDOW_MS = 5 * 60_000;
// Bounds window memory under IP-spoofing floods; the sample then reports ">= size" IPs.
const MAX_TRACKED_IPS = 5_000;

type UsageWindow = {
  startedAt: number;
  requests: number;
  apiRequests: number;
  ips: Set<string>;
  ipsOverflowed: boolean;
};

// Survives Next.js dev-mode module reloads, mirroring src/lib/prisma.ts.
const globalForUsage = globalThis as unknown as {
  usageWindow: UsageWindow | undefined;
};

function newWindow(now: number): UsageWindow {
  return {
    startedAt: now,
    requests: 0,
    apiRequests: 0,
    ips: new Set(),
    ipsOverflowed: false,
  };
}

export function trackRequest(ip: string, pathname: string): void {
  const now = Date.now();
  let window = globalForUsage.usageWindow;

  if (window && now - window.startedAt >= WINDOW_MS) {
    flushWindow(window, now);
    window = undefined;
  }
  if (!window) {
    window = globalForUsage.usageWindow = newWindow(now);
  }

  window.requests += 1;
  if (pathname.startsWith("/api/")) window.apiRequests += 1;
  if (window.ips.size < MAX_TRACKED_IPS) {
    window.ips.add(ip);
  } else if (!window.ips.has(ip)) {
    window.ipsOverflowed = true;
  }
}

function flushWindow(window: UsageWindow, endedAt: number): void {
  const minutes = Math.max(
    1,
    Math.round((endedAt - window.startedAt) / 60_000),
  );
  const ipCount = `${window.ips.size}${window.ipsOverflowed ? "+" : ""}`;
  void logSystemEvent({
    category: "USAGE",
    type: "USAGE_SAMPLE",
    severity: "INFO",
    message: `${window.requests} request(s) from ${ipCount} unique IP(s) over ${minutes} min`,
    metadata: {
      windowStart: new Date(window.startedAt).toISOString(),
      windowEnd: new Date(endedAt).toISOString(),
      requests: window.requests,
      apiRequests: window.apiRequests,
      uniqueIps: window.ips.size,
      uniqueIpsOverflowed: window.ipsOverflowed,
    },
  });
}
