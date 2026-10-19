import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/system-log", () => ({ logSystemEvent: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
}));

import { auth } from "@/lib/auth";
import { logSystemEvent } from "@/lib/system-log";
import {
  logDataExport,
  requireAdminApi,
  requireAdminDataPage,
  requireAdminDataReader,
  requireAdminPage,
} from "./admin-access";

const mockAuth = vi.mocked(auth);

function as(role: string | null) {
  mockAuth.mockResolvedValue(
    role ? ({ user: { id: `${role}-id`, role } } as never) : (null as never),
  );
}

async function status(gate: Promise<unknown>) {
  const result = await gate;
  return result instanceof Response ? result.status : 200;
}

beforeEach(() => {
  mockAuth.mockReset();
  vi.mocked(logSystemEvent).mockReset();
});

describe("requireAdminApi (config + every mutation)", () => {
  it.each([
    [null, 401],
    ["STUDENT", 403],
    ["TEACHER", 403],
    ["RESEARCHER", 403],
    ["ADMIN", 200],
  ])("%s -> %i", async (role, expected) => {
    as(role);
    expect(await status(requireAdminApi())).toBe(expected);
  });

  it("resolves to the session for an admin", async () => {
    as("ADMIN");
    const session = await requireAdminApi();
    expect(session).not.toBeInstanceOf(Response);
    expect((session as { user: { id: string } }).user.id).toBe("ADMIN-id");
  });
});

describe("requireAdminDataReader (read-only admin data)", () => {
  it.each([
    [null, 401],
    ["STUDENT", 403],
    ["TEACHER", 403],
    ["RESEARCHER", 200],
    ["ADMIN", 200],
  ])("%s -> %i", async (role, expected) => {
    as(role);
    expect(await status(requireAdminDataReader())).toBe(expected);
  });
});

describe("requireAdminPage", () => {
  it("admits an admin", async () => {
    as("ADMIN");
    await expect(requireAdminPage()).resolves.toBeTruthy();
  });
  it("sends a research scientist to the admin overview", async () => {
    as("RESEARCHER");
    await expect(requireAdminPage()).rejects.toThrow("REDIRECT:/admin");
  });
  it.each([null, "TEACHER", "STUDENT"])("sends %s to login", async (role) => {
    as(role);
    await expect(requireAdminPage()).rejects.toThrow("REDIRECT:/login");
  });
});

describe("requireAdminDataPage", () => {
  it.each(["ADMIN", "RESEARCHER"])("admits %s", async (role) => {
    as(role);
    await expect(requireAdminDataPage()).resolves.toBeTruthy();
  });
  it.each([null, "TEACHER", "STUDENT"])("sends %s to login", async (role) => {
    as(role);
    await expect(requireAdminDataPage()).rejects.toThrow("REDIRECT:/login");
  });
});

describe("logDataExport", () => {
  it("records an AUDIT event with the downloader's id and role", async () => {
    await logDataExport(
      { id: "r1", role: "RESEARCHER", email: "r@x.org" },
      "survey responses CSV",
      { rows: 3 },
    );
    expect(logSystemEvent).toHaveBeenCalledWith({
      category: "AUDIT",
      type: "DATA_EXPORT",
      message: "RESEARCHER r@x.org downloaded survey responses CSV",
      userId: "r1",
      metadata: {
        dataset: "survey responses CSV",
        role: "RESEARCHER",
        rows: 3,
      },
    });
  });
});
