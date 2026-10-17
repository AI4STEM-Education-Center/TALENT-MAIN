import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { redirect } from "next/navigation";
import AdminRegisterRedirect from "@/app/(auth)/admin-register/page";

const mockRedirect = vi.mocked(redirect);

const visit = (searchParams: Record<string, string | string[] | undefined>) =>
  AdminRegisterRedirect({ searchParams: Promise.resolve(searchParams) });

beforeEach(() => {
  mockRedirect.mockReset();
});

describe("/admin-register (legacy link)", () => {
  it("redirects to /register", async () => {
    await visit({});
    expect(mockRedirect).toHaveBeenCalledWith("/register");
  });

  it("carries ?code= over verbatim, whitespace and case included", async () => {
    await visit({ code: "  Adm1n Tok3n " });
    const target = mockRedirect.mock.calls[0][0];
    expect(new URL(target, "http://x").searchParams.get("code")).toBe(
      "  Adm1n Tok3n ",
    );
  });

  it("uses the first value when ?code= repeats", async () => {
    await visit({ code: ["first", "second"] });
    expect(mockRedirect).toHaveBeenCalledWith("/register?code=first");
  });
});
