import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { resetDb } from "../../test/db";
import {
  notifyAdminsOfRevokedTokenUse,
} from "./pressure-token-alert";

beforeEach(async () => {
  await resetDb();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("notifyAdminsOfRevokedTokenUse", () => {
  it("does nothing when there are no admins, without throwing", async () => {
    await expect(
      notifyAdminsOfRevokedTokenUse({
        id: "tok_1",
        name: "ci",
        tokenPrefix: "ptr_abc",
        useCount: 1,
        usedAt: new Date(),
        ip: null,
      })
    ).resolves.toBeUndefined();
  });
});
