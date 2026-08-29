// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantWidget } from "./AssistantWidget";
import { formatBytes, MAX_IMAGE_EDGE } from "./attachment-input";

describe("AssistantWidget", () => {
  it("renders nothing until /api/assistant/config says an assistant is available", () => {
    // The launcher must not flash for admins or signed-out users, so the
    // pre-fetch render has to be empty rather than a hidden-but-present button.
    expect(renderToStaticMarkup(<AssistantWidget />)).toBe("");
  });
});

describe("formatBytes", () => {
  it("scales the unit with the size", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3 MB");
  });
});

describe("MAX_IMAGE_EDGE", () => {
  it("stays within what vision models actually consume", () => {
    expect(MAX_IMAGE_EDGE).toBeLessThanOrEqual(2048);
  });
});
