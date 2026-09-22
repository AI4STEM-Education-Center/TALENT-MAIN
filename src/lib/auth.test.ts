import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next-auth", () => ({ default: vi.fn(() => ({})) }));
vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: vi.fn(), findFirst: vi.fn() } },
}));
vi.mock("@/lib/consent", () => ({
  getUserConsentClaim: vi.fn(),
  isConsentRole: vi.fn(() => false),
}));
vi.mock("@/lib/system-log", () => ({ logSystemEvent: vi.fn() }));
import { authConfig } from "./auth";
import { prisma } from "./prisma";
import { credentialVersion } from "./session-credentials";

const user = {
  id: "user",
  role: "ADMIN",
  firstName: "Ada",
  lastName: "Test",
  username: "ada",
  email: "ada@example.com",
  hashedPassword: "stored-bcrypt-hash",
};
const token = () => ({
  id: user.id,
  role: user.role,
  sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600,
  credentialVersion: credentialVersion(user.hashedPassword),
});
const jwt = (value: Record<string, unknown>) =>
  authConfig.callbacks.jwt({ token: value } as Parameters<
    typeof authConfig.callbacks.jwt
  >[0]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.user.findUnique).mockResolvedValue(user as never);
});

describe("session revocation", () => {
  it("keeps a current session and refreshes profile fields from the database", async () => {
    expect(await jwt(token())).toMatchObject({
      id: user.id,
      firstName: "Ada",
      username: "ada",
    });
  });
  it("rejects an existing JWT after its account is deleted", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    expect(await jwt(token())).toBeNull();
  });
  it("rejects an existing JWT after its account is demoted", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      ...user,
      role: "STUDENT",
    } as never);
    expect(await jwt(token())).toBeNull();
  });
  it("rejects an existing JWT after a password change or reset", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      ...user,
      hashedPassword: "new-hash",
    } as never);
    expect(await jwt(token())).toBeNull();
  });
  it("requires reauthentication for legacy cookies without a credential version", async () => {
    const { credentialVersion: _version, ...legacy } = token();
    expect(await jwt(legacy)).toBeNull();
  });
});

describe("credential input", () => {
  it.each([
    { identifier: [], password: "Password1!" },
    { identifier: "ada", password: {} },
    { identifier: " ", password: "Password1!" },
  ])(
    "rejects malformed credentials before querying the database",
    async (credentials) => {
      const provider = authConfig.providers[0];
      if (typeof provider === "function" || provider.type !== "credentials")
        throw new Error("Expected credentials provider");
      const configured = provider as typeof provider & {
        options: typeof provider;
      };
      await expect(
        configured.options.authorize(
          credentials,
          new Request("http://localhost"),
        ),
      ).resolves.toBeNull();
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    },
  );
});
