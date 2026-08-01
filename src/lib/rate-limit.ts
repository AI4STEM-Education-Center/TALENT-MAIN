import { NextResponse } from "next/server";

/**
 * In-memory fixed-window rate limiter.
 *
 * Counters live in process memory, so this is sized for the current
 * single-instance deployment: it resets on restart and is NOT shared across
 * instances. If the app is ever scaled horizontally, back this with a shared
 * store (e.g. Redis) so limits hold across replicas.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number };

/**
 * Pure fixed-window check. `key` is any stable identifier (typically
 * `${routeName}:${clientIp}`). Always enforces — the test-env bypass lives in
 * `rateLimit()` below so this stays unit-testable with an injected `now`.
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now()
): RateLimitResult {
  const existing = buckets.get(key);

  if (!existing || now >= existing.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    // Opportunistic cleanup so the map can't grow without bound.
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) {
        if (now >= v.resetAt) buckets.delete(k);
      }
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (existing.count >= limit) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
  }

  existing.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Best-effort client IP from the proxy chain (Cloudflare Tunnel → app).
 *
 * `cf-connecting-ip` is preferred because Cloudflare OVERWRITES it on every
 * proxied request, so a client can't forge it. `x-forwarded-for` is only
 * appended to, meaning its first entry is attacker-controlled if the origin is
 * ever reachable directly — trusting it first would let one host spread its
 * login attempts across unlimited synthetic buckets and slip the brute-force
 * throttle in src/lib/auth.ts. Keep the origin reachable only via the tunnel.
 */
export function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

/**
 * Route-facing guard. Returns a 429 `NextResponse` when the caller is over the
 * limit, or `null` when the request may proceed. Disabled under tests so route
 * specs aren't coupled to limiter state (the limiter is covered by its own
 * unit test).
 */
export function rateLimit(
  req: Request,
  name: string,
  limit: number,
  windowMs: number,
  identity?: string
): NextResponse | null {
  if (process.env.NODE_ENV === "test") return null;

  const result = checkRateLimit(`${name}:${identity ?? clientIp(req)}`, limit, windowMs);
  if (result.allowed) return null;

  return NextResponse.json(
    { error: "Too many requests. Please slow down and try again shortly." },
    { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } }
  );
}
