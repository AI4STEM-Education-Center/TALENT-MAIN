import { describe, it, expect } from "vitest";
import { roleToChatUseCase, buildProviderHeaders, type ResolvedProvider } from "./ai-provider";

// resolveProvider() (DB + cache TTL) is covered in test/ai-provider.resolve.test.ts.
// These cover the pure helpers.

describe("roleToChatUseCase", () => {
  it("maps STUDENT to student_chat", () => {
    expect(roleToChatUseCase("STUDENT")).toBe("student_chat");
  });

  it("maps TEACHER and ADMIN to teacher_chat", () => {
    expect(roleToChatUseCase("TEACHER")).toBe("teacher_chat");
    expect(roleToChatUseCase("ADMIN")).toBe("teacher_chat");
  });

  it("defaults unknown roles to teacher_chat", () => {
    expect(roleToChatUseCase("WHATEVER")).toBe("teacher_chat");
  });
});

function provider(overrides: Partial<ResolvedProvider>): ResolvedProvider {
  return {
    providerType: "openai",
    baseUrl: null,
    apiKey: "sk-x",
    model: "gpt-5.1",
    serviceTier: null,
    cfAigByokAlias: null,
    timeoutMs: 600_000,
    ...overrides,
  };
}

describe("buildProviderHeaders", () => {
  it("adds cf-aig-byok-alias for cloudflare with an alias", () => {
    const headers = buildProviderHeaders(
      provider({ providerType: "cloudflare", cfAigByokAlias: "my-alias" })
    );
    expect(headers).toEqual({ "cf-aig-byok-alias": "my-alias" });
  });

  it("returns no headers for cloudflare without an alias", () => {
    expect(
      buildProviderHeaders(provider({ providerType: "cloudflare", cfAigByokAlias: null }))
    ).toEqual({});
  });

  it("returns no headers for openai/local providers", () => {
    expect(buildProviderHeaders(provider({ providerType: "openai" }))).toEqual({});
    expect(
      buildProviderHeaders(provider({ providerType: "local", cfAigByokAlias: "ignored" }))
    ).toEqual({});
  });
});
