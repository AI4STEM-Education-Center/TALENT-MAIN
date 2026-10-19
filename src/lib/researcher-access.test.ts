import { describe, it, expect } from "vitest";
import { isResearcherAdminPath } from "./researcher-access";

describe("isResearcherAdminPath", () => {
  it.each([
    "/admin",
    "/admin/",
    "/admin/users",
    "/admin/classes/c1/quizzes/q1/stats",
    "/admin/quizzes/q1",
    "/admin/materials/m1",
    "/admin/surveys/s1/responses",
    "/admin/consent",
    "/admin/research-pool",
    "/admin/resource-engagement",
    "/admin/logs",
  ])("allows the data page %s", (path) => {
    expect(isResearcherAdminPath(path)).toBe(true);
  });

  it.each([
    "/admin/ai-config",
    "/admin/email",
    "/admin/backup",
    "/admin/teacher-codes",
    "/admin/pressure-tests",
    "/admin/resources",
    "/admin/research-email",
    "/admin/research-email/interview",
    "/admin/post-survey-email",
    "/admin/consent/forms",
    "/admin/consent/settings",
    "/admin/research-pool/email",
    "/admin/usersx",
    "/admin/logs-archive",
    "/teacher",
  ])("refuses %s", (path) => {
    expect(isResearcherAdminPath(path)).toBe(false);
  });
});
