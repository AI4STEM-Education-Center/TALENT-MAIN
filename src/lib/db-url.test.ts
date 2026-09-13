import { describe, it, expect } from "vitest";
import path from "node:path";
import { resolveDatabaseUrl } from "./db-url";

const inPrisma = (rel: string) => `file:${path.join(process.cwd(), "prisma", rel)}`;

describe("resolveDatabaseUrl", () => {
  it("returns an empty string for an empty / falsy URL", () => {
    expect(resolveDatabaseUrl("")).toBe("");
  });

  it("returns non-file URLs unchanged", () => {
    expect(resolveDatabaseUrl("postgresql://localhost:5432/app")).toBe(
      "postgresql://localhost:5432/app"
    );
  });

  it("returns file::memory: unchanged", () => {
    expect(resolveDatabaseUrl("file::memory:")).toBe("file::memory:");
  });

  it("leaves an already-absolute file path untouched", () => {
    expect(resolveDatabaseUrl("file:/var/data/prod.db")).toBe("file:/var/data/prod.db");
  });

  it("re-anchors a relative path to <cwd>/prisma and makes it absolute", () => {
    expect(resolveDatabaseUrl("file:./data/prod.db")).toBe(inPrisma("./data/prod.db"));
    expect(resolveDatabaseUrl("file:dev.db")).toBe(inPrisma("dev.db"));
  });

  it("drops engine-only query params like connection_limit", () => {
    const result = resolveDatabaseUrl("file:dev.db?connection_limit=1");
    expect(result).toBe(inPrisma("dev.db"));
    expect(result).not.toContain("connection_limit");
  });

  it("preserves an absolute path while still stripping query params", () => {
    expect(resolveDatabaseUrl("file:/srv/app.db?connection_limit=1")).toBe("file:/srv/app.db");
  });
});
