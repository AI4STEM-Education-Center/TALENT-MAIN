import { describe, it, expect } from "vitest";
import {
  ROLE_LABELS,
  canViewAdminData,
  homePathForRole,
  isAdmin,
  isInviteCodeRole,
  isRole,
  roleLabel,
} from "@/lib/roles";

describe("roles", () => {
  it("labels RESEARCHER as a research scientist", () => {
    expect(ROLE_LABELS.RESEARCHER).toBe("Research scientist");
    expect(roleLabel("RESEARCHER")).toBe("Research scientist");
    expect(roleLabel("WHATEVER")).toBe("WHATEVER");
  });

  it("sends each role to its home", () => {
    expect(homePathForRole("ADMIN")).toBe("/admin");
    expect(homePathForRole("RESEARCHER")).toBe("/admin");
    expect(homePathForRole("TEACHER")).toBe("/teacher");
    expect(homePathForRole("STUDENT")).toBe("/student");
    expect(homePathForRole(undefined)).toBe("/student");
  });

  it("lets ADMIN and RESEARCHER view admin data, but only ADMIN administer", () => {
    expect(canViewAdminData("ADMIN")).toBe(true);
    expect(canViewAdminData("RESEARCHER")).toBe(true);
    expect(canViewAdminData("TEACHER")).toBe(false);
    expect(canViewAdminData(undefined)).toBe(false);
    expect(isAdmin("ADMIN")).toBe(true);
    expect(isAdmin("RESEARCHER")).toBe(false);
  });

  it("guards role strings", () => {
    expect(isRole("RESEARCHER")).toBe(true);
    expect(isRole("researcher")).toBe(false);
    expect(isInviteCodeRole("TEACHER")).toBe(true);
    expect(isInviteCodeRole("RESEARCHER")).toBe(true);
    expect(isInviteCodeRole("ADMIN")).toBe(false);
    expect(isInviteCodeRole("STUDENT")).toBe(false);
  });
});
