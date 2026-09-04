import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET as ADMIN_GET } from "@/app/api/admin/resources/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  clearResourceReportCache,
  pruneResourceSamples,
} from "@/lib/resource-monitor";
import { encodeSample } from "@/lib/resource-spool";
import type { ResourceSampleInput } from "@/lib/resource-metrics";

const mockAuth = vi.mocked(auth);
const asAdmin = () =>
  mockAuth.mockResolvedValue({ user: { id: "a", role: "ADMIN" } } as never);
const asTeacher = () =>
  mockAuth.mockResolvedValue({ user: { id: "t", role: "TEACHER" } } as never);

let spoolDir: string;

function adminReq(range?: string) {
  const url = range
    ? `http://localhost/api/admin/resources?range=${range}`
    : "http://localhost/api/admin/resources";
  return new NextRequest(url);
}

/** A sample as a node would have written it, `minutesAgo` in the past. */
function writeSample(
  nodeId: string,
  minutesAgo: number,
  over: Partial<ResourceSampleInput> = {},
) {
  const [appEnv, role] = nodeId.split("-");
  const at = Date.now() - minutesAgo * 60_000;
  const sample = {
    nodeId,
    appEnv,
    role,
    hostname: `${nodeId}-box`,
    cpuPercent: 12.5,
    cpuCores: 2,
    memUsedBytes: 512_000_000,
    memLimitBytes: 2_048_000_000,
    dbBytes: 10_000_000,
    diskTotalBytes: 20_000_000_000,
    diskFreeBytes: 4_000_000_000,
    s3Bytes: null,
    hostCpuPercent: 30,
    hostCpuCores: 2,
    hostMemUsedBytes: 1_200_000_000,
    hostMemTotalBytes: 2_048_000_000,
    ...over,
  } as ResourceSampleInput;
  fs.appendFileSync(
    path.join(spoolDir, `${nodeId}.ndjson`),
    encodeSample(sample, at),
  );
}

beforeEach(async () => {
  spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "resource-spool-"));
  process.env.RESOURCE_SPOOL_DIR = spoolDir;
  await prisma.resourceSample.deleteMany();
  clearResourceReportCache();
  mockAuth.mockReset();
});

afterEach(() => {
  fs.rmSync(spoolDir, { recursive: true, force: true });
  delete process.env.RESOURCE_SPOOL_DIR;
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
    writeSample("dev-web", 5, { cpuPercent: 20 });
    writeSample("dev-web", 4, { cpuPercent: 40 });
    writeSample("dev-worker", 5, { cpuPercent: 3, s3Bytes: 8_000_000 });

    const body = await (await ADMIN_GET(adminReq("1h"))).json();

    expect(body.nodes.map((n: { nodeId: string }) => n.nodeId)).toEqual([
      "dev-web",
      "dev-worker",
    ]);
    const web = body.nodes.find(
      (n: { nodeId: string }) => n.nodeId === "dev-web",
    );
    expect(web.cpuCores).toBe(2);
    expect(web.points.length).toBeGreaterThan(0);
    expect(
      web.points.every((p: { cpuPercent: number }) => p.cpuPercent >= 20),
    ).toBe(true);
  });

  it("charts both deployments from the one shared spool", async () => {
    // The point of the pivot: prod's nodes appear here without this deployment
    // making any cross-deployment request, because prod wrote into the same
    // mounted directory.
    asAdmin();
    writeSample("dev-web", 3);
    writeSample("dev-worker", 3);
    writeSample("prod-web", 3);
    writeSample("prod-worker", 3);

    const body = await (await ADMIN_GET(adminReq("1h"))).json();

    expect(body.nodes.map((n: { nodeId: string }) => n.nodeId)).toEqual([
      "dev-web",
      "dev-worker",
      "prod-web",
      "prod-worker",
    ]);
    expect(body.spool.shared).toBe(true);
    expect(body.spool.files).toHaveLength(4);
  });

  it("derives one whole-machine series from whichever nodes reported", async () => {
    asAdmin();
    writeSample("dev-web", 3, { hostCpuPercent: 42 });
    // A node that just restarted has no host CPU delta yet; it must not drag
    // the machine's figure down to zero.
    writeSample("prod-web", 3, { hostCpuPercent: null });

    const body = await (await ADMIN_GET(adminReq("1h"))).json();

    const last = body.host.points[body.host.points.length - 1];
    expect(last.cpuPercent).toBe(42);
    expect(body.host.cpuCores).toBe(2);
    expect(body.host.memTotalBytes).toBe(2_048_000_000);
    expect(body.host.diskTotalBytes).toBe(20_000_000_000);
  });

  it("carries the machine's size forward past a node that cannot report it", async () => {
    // The newest sample is from a node with no host readings at all. The disk
    // is still measurable from its bind mount, but core count and RAM must come
    // from the last node that did know them, not blank out.
    asAdmin();
    writeSample("dev-web", 10);
    writeSample("dev-web", 1, {
      hostCpuPercent: null,
      hostCpuCores: null,
      hostMemUsedBytes: null,
      hostMemTotalBytes: null,
    });

    const body = await (await ADMIN_GET(adminReq("1h"))).json();
    expect(body.host.cpuCores).toBe(2);
    expect(body.host.memTotalBytes).toBe(2_048_000_000);
    expect(body.host.diskTotalBytes).toBe(20_000_000_000);
  });

  it("reports no host series when nothing has sampled", async () => {
    asAdmin();
    const body = await (await ADMIN_GET(adminReq())).json();
    expect(body.host).toBeNull();
    expect(body.nodes).toEqual([]);
  });

  it("flags a private spool, which can only see this deployment", async () => {
    asAdmin();
    delete process.env.RESOURCE_SPOOL_DIR;
    clearResourceReportCache();

    const body = await (await ADMIN_GET(adminReq())).json();
    expect(body.spool.shared).toBe(false);
  });

  it("falls back to the default range when the parameter is junk", async () => {
    asAdmin();
    const body = await (await ADMIN_GET(adminReq("everything"))).json();
    expect(body.range).toBe("24h");
  });

  it("excludes samples older than the requested window", async () => {
    asAdmin();
    writeSample("dev-web", 5);
    writeSample("dev-worker", 6 * 60);

    const body = await (await ADMIN_GET(adminReq("1h"))).json();
    expect(body.nodes.map((n: { nodeId: string }) => n.nodeId)).toEqual([
      "dev-web",
    ]);
  });
});

describe("pruneResourceSamples", () => {
  it("drains the retired table down to the retention window", async () => {
    // Nothing writes ResourceSample any more, but rows predating the move to
    // the spool are still in both databases and must age out.
    const row = (minutesAgo: number) => ({
      nodeId: "dev-web",
      appEnv: "dev",
      role: "web",
      hostname: "box",
      createdAt: new Date(Date.now() - minutesAgo * 60_000),
      cpuPercent: 1,
      cpuCores: 2,
      memUsedBytes: 1,
      memLimitBytes: 2,
      dbBytes: 1,
      diskTotalBytes: 2,
      diskFreeBytes: 1,
      s3Bytes: null,
    });
    await prisma.resourceSample.createMany({
      data: [row(60), row(8 * 24 * 60)],
    });

    expect(await pruneResourceSamples()).toBe(1);
    expect(await prisma.resourceSample.findMany()).toHaveLength(1);
  });
});
