import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  parseDeviceType,
  normalizeStrokeData,
  isConsentRole,
  isConsentDecision,
  getActiveConsentVersion,
  getUserConsentClaim,
  hasResearchConsent,
} from "@/lib/consent";
import { prisma } from "@/lib/prisma";
import { resetDb, createStudent } from "./db";

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("parseDeviceType", () => {
  it("classifies common user-agent strings", () => {
    expect(parseDeviceType(null)).toBe("unknown");
    expect(parseDeviceType("")).toBe("unknown");
    expect(
      parseDeviceType(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
      )
    ).toBe("desktop");
    expect(
      parseDeviceType("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15")
    ).toBe("mobile");
    expect(parseDeviceType("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15")).toBe(
      "tablet"
    );
    expect(parseDeviceType("some-unrecognized-bot/1.0")).toBe("unknown");
  });
});

describe("normalizeStrokeData", () => {
  it("returns null for empty/absent input", () => {
    expect(normalizeStrokeData(undefined)).toBeNull();
    expect(normalizeStrokeData(null)).toBeNull();
    expect(normalizeStrokeData([])).toBeNull();
  });

  it("accepts and round-trips a plausible signature_pad point-group array", () => {
    const data = [{ points: [{ x: 1, y: 2, time: 0 }, { x: 3, y: 4, time: 10 }] }];
    const normalized = normalizeStrokeData(data);
    expect(normalized).not.toBeNull();
    expect(JSON.parse(normalized!)).toEqual(data);
  });

  it("rejects a non-array payload", () => {
    expect(normalizeStrokeData({ not: "an array" })).toBeNull();
  });

  it("throws on an oversized payload rather than silently truncating", () => {
    const huge = [{ points: Array.from({ length: 5000 }, (_, i) => ({ x: i, y: i, time: i })) }];
    expect(() => normalizeStrokeData(huge)).toThrow(/too large/i);
  });
});

describe("isConsentRole / isConsentDecision", () => {
  it("accepts only the known values", () => {
    expect(isConsentRole("STUDENT")).toBe(true);
    expect(isConsentRole("TEACHER")).toBe(true);
    expect(isConsentRole("ADMIN")).toBe(false);
    expect(isConsentRole(42)).toBe(false);

    expect(isConsentDecision("AGREE")).toBe(true);
    expect(isConsentDecision("DECLINE")).toBe(true);
    expect(isConsentDecision("MAYBE")).toBe(false);
  });
});

async function publishVersion(role: "STUDENT" | "TEACHER", version = "v1") {
  return prisma.consentFormVersion.create({
    data: { role, version, title: `${role} form`, bodyHtml: "<p>hello</p>", isActive: true },
  });
}

describe("getActiveConsentVersion / getUserConsentClaim", () => {
  it("returns null when no form is published for a role", async () => {
    expect(await getActiveConsentVersion("STUDENT")).toBeNull();
  });

  it("returns the active version and null claim before anyone has decided", async () => {
    const version = await publishVersion("STUDENT");
    expect((await getActiveConsentVersion("STUDENT"))?.id).toBe(version.id);

    const { user } = await createStudent();
    expect(await getUserConsentClaim(user.id, "STUDENT")).toBeNull();
  });

  it("reflects a recorded decision on the active version", async () => {
    const version = await publishVersion("STUDENT");
    const { user } = await createStudent();
    await prisma.consentRecord.create({
      data: {
        userId: user.id,
        role: "STUDENT",
        formVersionId: version.id,
        decision: "AGREE",
        signatureTypedName: "Stu Student",
        ipAddress: "127.0.0.1",
        userAgent: "test",
        deviceType: "desktop",
        signerNameSnapshot: "Stu Student",
        signerEmailSnapshot: user.email,
      },
    });

    expect(await getUserConsentClaim(user.id, "STUDENT")).toEqual({ version: "v1", decision: "AGREE" });
  });

  it("goes back to null after a new version is published, even with an old AGREE on file", async () => {
    const v1 = await publishVersion("STUDENT", "v1");
    const { user } = await createStudent();
    await prisma.consentRecord.create({
      data: {
        userId: user.id,
        role: "STUDENT",
        formVersionId: v1.id,
        decision: "AGREE",
        signatureTypedName: "Stu Student",
        ipAddress: "127.0.0.1",
        userAgent: "test",
        deviceType: "desktop",
        signerNameSnapshot: "Stu Student",
        signerEmailSnapshot: user.email,
      },
    });

    // Publishing v2 deactivates v1 — the same transaction the admin publish route runs.
    await prisma.$transaction([
      prisma.consentFormVersion.updateMany({ where: { role: "STUDENT", isActive: true }, data: { isActive: false } }),
      prisma.consentFormVersion.create({
        data: { role: "STUDENT", version: "v2", title: "STUDENT form", bodyHtml: "<p>v2</p>", isActive: true },
      }),
    ]);

    expect(await getUserConsentClaim(user.id, "STUDENT")).toBeNull();
  });
});

describe("hasResearchConsent", () => {
  it("defaults to false with no active form or no decision", async () => {
    const { user } = await createStudent();
    expect(await hasResearchConsent(user.id)).toBe(false);

    await publishVersion("STUDENT");
    expect(await hasResearchConsent(user.id)).toBe(false);
  });

  it("is true only for an AGREE decision on the currently active version", async () => {
    const version = await publishVersion("STUDENT");
    const { user: agreedUser } = await createStudent();
    const { user: declinedUser } = await createStudent();

    await prisma.consentRecord.create({
      data: {
        userId: agreedUser.id,
        role: "STUDENT",
        formVersionId: version.id,
        decision: "AGREE",
        signatureTypedName: "A",
        ipAddress: "127.0.0.1",
        userAgent: "test",
        deviceType: "desktop",
        signerNameSnapshot: "A",
        signerEmailSnapshot: agreedUser.email,
      },
    });
    await prisma.consentRecord.create({
      data: {
        userId: declinedUser.id,
        role: "STUDENT",
        formVersionId: version.id,
        decision: "DECLINE",
        signatureTypedName: "B",
        ipAddress: "127.0.0.1",
        userAgent: "test",
        deviceType: "desktop",
        signerNameSnapshot: "B",
        signerEmailSnapshot: declinedUser.email,
      },
    });

    expect(await hasResearchConsent(agreedUser.id)).toBe(true);
    expect(await hasResearchConsent(declinedUser.id)).toBe(false);
  });

  it("stops collection when the latest decision changes from AGREE to DECLINE", async () => {
    const version = await publishVersion("STUDENT");
    const { user } = await createStudent();
    const base = {
      userId: user.id,
      role: "STUDENT",
      formVersionId: version.id,
      signatureTypedName: "Student",
      ipAddress: "127.0.0.1",
      userAgent: "test",
      deviceType: "desktop",
      signerNameSnapshot: "Student",
      signerEmailSnapshot: user.email,
    };
    await prisma.consentRecord.create({
      data: { ...base, decision: "AGREE", signedAt: new Date("2026-01-01T00:00:00Z") },
    });
    await prisma.consentRecord.create({
      data: { ...base, decision: "DECLINE", signedAt: new Date("2026-01-02T00:00:00Z") },
    });

    expect(await hasResearchConsent(user.id)).toBe(false);
  });
});
