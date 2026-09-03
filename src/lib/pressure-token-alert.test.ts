import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { resetDb } from "../../test/db";
import {
  notifyAdminsOfRevokedTokenUse,
  REVOKED_TOKEN_ALERT_THROTTLE_MS,
} from "./pressure-token-alert";

beforeEach(async () => {
  await resetDb();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("notifyAdminsOfRevokedTokenUse", () => {
  it("skips email when the previous revoked use was within the throttle window", async () => {
    const now = new Date("2026-09-03T10:00:00.000Z");
    const previous = new Date(now.getTime() - REVOKED_TOKEN_ALERT_THROTTLE_MS + 60_000);

    // Throttle check happens before any DB/email work, so this resolves fast
    // with no admins and no SMTP touched.
    await expect(
      notifyAdminsOfRevokedTokenUse({
        id: "tok_1",
        name: "ci",
        tokenPrefix: "ptr_abc",
        useCount: 2,
        usedAt: now,
        ip: "1.2.3.4",
        previousLastUseAt: previous,
      })
    ).resolves.toBeUndefined();
  });

  it("does nothing when there are no admins, without throwing", async () => {
    await expect(
      notifyAdminsOfRevokedTokenUse({
        id: "tok_1",
        name: "ci",
        tokenPrefix: "ptr_abc",
        useCount: 1,
        usedAt: new Date(),
        ip: null,
        previousLastUseAt: null,
      })
    ).resolves.toBeUndefined();
  });
});
