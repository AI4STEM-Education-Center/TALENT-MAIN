import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET as ADMIN_GET } from "@/app/api/admin/resources/route";
import { GET as PEER_GET } from "@/app/api/internal/resource-samples/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { clearResourceReportCache, pruneResourceSamples } from "@/lib/resource-monitor";

const mockAuth = vi.mocked(auth);
const asAdmin = () => mockAuth.mockResolvedValue({ user: { id: "a", role: "ADMIN" } } as never);
const asTeacher = () => mockAuth.mockResolvedValue({ user: { id: "t", role: "TEACHER" } } as never);

function adminReq(range?: string) {
  const url = range
    ? `http://localhost/api/admin/resources?range=${range}`
    : "http://localhost/api/admin/resources";
  return new NextRequest(url);
}

function peerReq(token?: string, range = "24h") {
  return new NextRequest(`http://localhost/api/internal/resource-samples?range=${range}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

/** A sample as the collector would write it, `minutesAgo` in the past. */
function sampleRow(nodeId: string, minutesAgo: number, over: Record<string, unknown> = {}) {
  const [appEnv, role] = nodeId.split("-");
  return {
    nodeId,
    appEnv,
    role,
    hostname: `${nodeId}-box`,
    createdAt: new Date(Date.now() - minutesAgo * 60_000),
    cpuPercent: 12.5,
    cpuCores: 4,
    memUsedBytes: 512_000_000,
    memLimitBytes: 2_048_000_000,
    dbBytes: 10_000_000,
    diskTotalBytes: 500_000_000_000,
    diskFreeBytes: 300_000_000_000,
    s3Bytes: null,
    ...over,
  };
}

beforeEach(async () => {
  await prisma.resourceSample.deleteMany();
  clearResourceReportCache();
  mockAuth.mockReset();
  delete process.env.RESOURCE_MONITOR_TOKEN;
  delete process.env.RESOURCE_MONITOR_PEER_URL;
});

afterAll(async () => {
  await prisma.resourceSample.deleteMany();
  await prisma.$disconnect();
});

describe("GET /api/admin/resources", () => {
  it("401s anyone who is not an admin", async () => {
    asTeacher();
    expect((await ADMIN_GET(adminReq())).status).toBe(401);
    mockAuth.mockResolvedValue(null as never);
    expect((await ADMIN_GET(adminReq())).status).toBe(401);
  });

  it("returns one bucketed series per node that reported", async () => {
    asAdmin();
    await prisma.resourceSample.createMany({
      data: [
        sampleRow("dev-web", 5, { cpuPercent: 20 }),
        sampleRow("dev-web", 4, { cpuPercent: 40 }),
        sampleRow("dev-worker", 5, { cpuPercent: 3, s3Bytes: 8_000_000 }),
      ],
    });

    const body = await (await ADMIN_GET(adminReq("1h"))).json();

    expect(body.nodes.map((n: { nodeId: string }) => n.nodeId)).toEqual(["dev-web", "dev-worker"]);
    const web = body.nodes.find((n: { nodeId: string }) => n.nodeId === "dev-web");
    expect(web.cpuCores).toBe(4);
    expect(web.points.length).toBeGreaterThan(0);
    expect(web.points.every((p: { cpuPercent: number }) => p.cpuPercent >= 20)).toBe(true);
  });

  it("falls back to the default range when the parameter is junk", async () => {
    asAdmin();
    const body = await (await ADMIN_GET(adminReq("everything"))).json();
    expect(body.range).toBe("24h");
  });

  it("reports the peer as unconfigured instead of failing when no token is set", async () => {
    asAdmin();
    const body = await (await ADMIN_GET(adminReq())).json();
    expect(body.peer).toEqual({ configured: false, ok: false, url: null, error: null });
    expect(body.nodes).toEqual([]);
  });

  it("excludes samples older than the requested window", async () => {
    asAdmin();
    await prisma.resourceSample.createMany({
      data: [sampleRow("dev-web", 5), sampleRow("dev-worker", 6 * 60)],
    });

    const body = await (await ADMIN_GET(adminReq("1h"))).json();
    expect(body.nodes.map((n: { nodeId: string }) => n.nodeId)).toEqual(["dev-web"]);
  });
});

describe("GET /api/internal/resource-samples", () => {
  it("401s without a token, with a wrong token, or when none is configured", async () => {
    // No RESOURCE_MONITOR_TOKEN set: the endpoint must stay shut, not open.
    expect((await PEER_GET(peerReq("anything"))).status).toBe(401);

    process.env.RESOURCE_MONITOR_TOKEN = "s3cret-peer-token";
    expect((await PEER_GET(peerReq())).status).toBe(401);
    expect((await PEER_GET(peerReq("wrong"))).status).toBe(401);
    // A prefix of the real token must not pass either.
    expect((await PEER_GET(peerReq("s3cret"))).status).toBe(401);
  });

  it("serves this deployment's report to a caller with the shared token", async () => {
    process.env.RESOURCE_MONITOR_TOKEN = "s3cret-peer-token";
    await prisma.resourceSample.create({ data: sampleRow("dev-worker", 2) });

    const res = await PEER_GET(peerReq("s3cret-peer-token"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.range).toBe("24h");
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].nodeId).toBe("dev-worker");
  });

  it("never requires a session — the caller is a server, not a user", async () => {
    process.env.RESOURCE_MONITOR_TOKEN = "s3cret-peer-token";
    mockAuth.mockResolvedValue(null as never);
    expect((await PEER_GET(peerReq("s3cret-peer-token"))).status).toBe(200);
  });
});

describe("pruneResourceSamples", () => {
  it("deletes only rows past the retention window", async () => {
    await prisma.resourceSample.createMany({
      data: [
        sampleRow("dev-web", 60), // an hour old — keep
        sampleRow("dev-web", 8 * 24 * 60), // eight days old — drop
      ],
    });

    expect(await pruneResourceSamples()).toBe(1);
    const left = await prisma.resourceSample.findMany();
    expect(left).toHaveLength(1);
  });
});
