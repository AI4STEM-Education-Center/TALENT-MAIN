/**
 * Next.js instrumentation hook — runs once per server process at startup.
 *
 * Used to start this web node's resource sampler, the web-side half of the
 * admin System Resources tab (the worker starts its own in src/worker.ts).
 * Sampling has to live here rather than in a route, because a node's CPU and
 * memory history must keep being recorded whether or not anyone is looking at
 * the admin page.
 */
export async function register() {
  // The hook is also evaluated for the edge runtime, which has no filesystem,
  // no cgroups and no Prisma. Only the Node.js server samples.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // `next build` renders pages in a server-like process; a build machine's
  // numbers are not a deployed node's, and its database may not even exist.
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  // Imported lazily so the edge/build paths above never pull in Prisma.
  const { startResourceSampler } = await import("@/lib/resource-monitor");
  startResourceSampler("web");
}
