import { describe, it, expect } from "vitest";
import { resolveWebdavConfig } from "./webdav";

describe("resolveWebdavConfig", () => {
  it("returns null when no URL is configured", () => {
    expect(resolveWebdavConfig(null)).toBeNull();
    expect(resolveWebdavConfig({ webdavUrl: null })).toBeNull();
  });

  it("resolves the DB row", () => {
    const cfg = resolveWebdavConfig({
      webdavUrl: "https://dav.example/files",
      webdavUsername: "alice",
      password: "secret",
      baseDir: "/db-backups",
    });
    expect(cfg).toEqual({
      url: "https://dav.example/files",
      username: "alice",
      password: "secret",
      baseDir: "/db-backups",
    });
  });

  it("normalizes baseDir (leading slash added, trailing removed)", () => {
    expect(
      resolveWebdavConfig({ webdavUrl: "https://x/y", baseDir: "backups/sub/" })?.baseDir,
    ).toBe("/backups/sub");
  });

  it("defaults baseDir to /backups", () => {
    expect(resolveWebdavConfig({ webdavUrl: "https://x/y" })?.baseDir).toBe("/backups");
  });
});
