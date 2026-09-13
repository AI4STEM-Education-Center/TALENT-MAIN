import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compactSpoolFile,
  createSpoolWriter,
  decodeSample,
  encodeSample,
  isSharedSpool,
  readSpool,
  resolveSpoolDir,
} from "./resource-spool";
import type { ResourceSampleInput } from "./resource-metrics";

let dir: string;

const sample = (over: Partial<ResourceSampleInput> = {}): ResourceSampleInput =>
  ({
    nodeId: "dev-web",
    appEnv: "dev",
    role: "web",
    hostname: "container-abc",
    cpuPercent: 12.5,
    cpuCores: 2,
    memUsedBytes: 208_000_000,
    memLimitBytes: 1_900_000_000,
    dbBytes: 21_600_000,
    diskTotalBytes: 20_900_000_000,
    diskFreeBytes: 3_500_000_000,
    s3Bytes: null,
    hostCpuPercent: 30,
    hostCpuCores: 2,
    hostMemUsedBytes: 1_200_000_000,
    hostMemTotalBytes: 1_900_000_000,
    ...over,
  }) as ResourceSampleInput;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "spool-"));
  process.env.RESOURCE_SPOOL_DIR = dir;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.RESOURCE_SPOOL_DIR;
});

describe("spool location", () => {
  it("uses RESOURCE_SPOOL_DIR when both stacks were pointed at one directory", () => {
    expect(resolveSpoolDir()).toBe(dir);
    expect(isSharedSpool()).toBe(true);
  });

  it("falls back to a private directory rather than failing", () => {
    delete process.env.RESOURCE_SPOOL_DIR;
    expect(isSharedSpool()).toBe(false);
    // Beside the data directory, never inside it — inside, the spool's own
    // bytes would be counted as database bytes.
    expect(path.basename(resolveSpoolDir())).toBe("resource-metrics");
  });
});

describe("encode / decode", () => {
  it("round-trips every field", () => {
    const at = Date.UTC(2026, 7, 17, 10, 0, 0);
    const decoded = decodeSample(
      encodeSample(sample({ s3Bytes: 87_200_000 }), at),
    );
    expect(decoded).toMatchObject({
      nodeId: "dev-web",
      appEnv: "dev",
      role: "web",
      hostname: "container-abc",
      cpuPercent: 12.5,
      cpuCores: 2,
      s3Bytes: 87_200_000,
      hostCpuPercent: 30,
      hostMemTotalBytes: 1_900_000_000,
    });
    expect(decoded?.createdAt.getTime()).toBe(at);
  });

  it("keeps a missing host reading null rather than turning it into zero", () => {
    const decoded = decodeSample(
      encodeSample(sample({ hostCpuPercent: null }), Date.now()),
    );
    expect(decoded?.hostCpuPercent).toBeNull();
  });

  it("rejects blank, malformed and unknown-version lines", () => {
    expect(decodeSample("")).toBeNull();
    expect(decodeSample("{not json")).toBeNull();
    // A line half-written when the box lost power must cost one sample, not
    // the whole file.
    expect(decodeSample('{"v":1,"t":1755')).toBeNull();
    expect(decodeSample('{"v":99,"t":1,"id":"dev-web"}')).toBeNull();
    expect(decodeSample('{"v":1,"id":"dev-web"}')).toBeNull();
  });
});

describe("writing and reading", () => {
  it("keeps one file per node and reads them all back together", () => {
    const now = Date.now();
    createSpoolWriter("dev-web", 60_000).write(sample(), now);
    createSpoolWriter("prod-worker", 60_000).write(
      sample({ nodeId: "prod-worker", appEnv: "prod", role: "worker" }),
      now,
    );

    const { samples, files, error } = readSpool(now - 60_000);
    expect(error).toBeNull();
    expect(files).toEqual(["dev-web.ndjson", "prod-worker.ndjson"]);
    expect(samples.map((s) => s.nodeId).sort()).toEqual([
      "dev-web",
      "prod-worker",
    ]);
  });

  it("returns samples oldest first across files", () => {
    const now = Date.now();
    createSpoolWriter("dev-web", 60_000).write(sample(), now - 2000);
    createSpoolWriter("prod-web", 60_000).write(
      sample({ nodeId: "prod-web" }),
      now - 3000,
    );
    createSpoolWriter("dev-worker", 60_000).write(
      sample({ nodeId: "dev-worker" }),
      now - 1000,
    );

    const times = readSpool(0).samples.map((s) => s.createdAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("drops samples older than the requested window", () => {
    const now = Date.now();
    const writer = createSpoolWriter("dev-web", 24 * 60 * 60_000);
    writer.write(sample(), now - 90 * 60_000);
    writer.write(sample(), now - 5 * 60_000);

    expect(readSpool(now - 60 * 60_000).samples).toHaveLength(1);
  });

  it("treats a missing spool directory as empty, not as an error", () => {
    process.env.RESOURCE_SPOOL_DIR = path.join(dir, "not-created-yet");
    expect(readSpool(0)).toEqual({ samples: [], files: [], error: null });
  });

  it("ignores files that are not node spools", () => {
    fs.writeFileSync(path.join(dir, "README.txt"), "not a spool");
    createSpoolWriter("dev-web", 60_000).write(sample(), Date.now());
    expect(readSpool(0).files).toEqual(["dev-web.ndjson"]);
  });

  it("refuses a node id that could escape the spool directory", () => {
    expect(() => createSpoolWriter("../../etc/passwd", 60_000)).toThrow(
      /Unsafe node id/,
    );
  });
});

describe("compaction", () => {
  it("keeps the retention window and drops what is past it", () => {
    const now = Date.now();
    const file = path.join(dir, "dev-web.ndjson");
    fs.writeFileSync(
      file,
      [
        encodeSample(sample(), now - 8 * 24 * 60 * 60_000),
        encodeSample(sample(), now - 2 * 24 * 60 * 60_000),
        encodeSample(sample(), now),
      ].join(""),
    );

    expect(compactSpoolFile(file, now - 7 * 24 * 60 * 60_000)).toBe(1);
    expect(readSpool(0).samples).toHaveLength(2);
  });

  it("leaves the file untouched when nothing has aged out", () => {
    const now = Date.now();
    const file = path.join(dir, "dev-web.ndjson");
    fs.writeFileSync(file, encodeSample(sample(), now));
    const before = fs.readFileSync(file, "utf8");

    expect(compactSpoolFile(file, now - 60_000)).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("drops unparseable lines it encounters on the way past", () => {
    const now = Date.now();
    const file = path.join(dir, "dev-web.ndjson");
    fs.writeFileSync(file, `{"v":1,"t":${now}\n${encodeSample(sample(), now)}`);

    expect(compactSpoolFile(file, now - 60_000)).toBe(1);
    expect(readSpool(0).samples).toHaveLength(1);
  });

  it("survives a file that does not exist", () => {
    expect(compactSpoolFile(path.join(dir, "gone.ndjson"), Date.now())).toBe(0);
  });

  it("bounds the file the writer keeps: the first write compacts", () => {
    const now = Date.now();
    const file = path.join(dir, "dev-web.ndjson");
    // A restart inherits whatever the previous process left behind, so the
    // writer must not wait an hour before trimming it.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, encodeSample(sample(), now - 30 * 24 * 60 * 60_000));

    createSpoolWriter("dev-web", 7 * 24 * 60 * 60_000).write(sample(), now);
    expect(readSpool(0).samples).toHaveLength(1);
  });
});
