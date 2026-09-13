import { afterEach, describe, expect, it } from "vitest";
import {
  PAGE_IMAGE_EXTENSION_VALUES,
  pageImageExtension,
  parsePageImageMimeType,
  preferredPageImageMimeType,
  suffixPageImageKey,
} from "./page-image-format";

const originalFormat = process.env.NEXT_PUBLIC_PAGE_IMAGE_FORMAT;

afterEach(() => {
  if (originalFormat === undefined) delete process.env.NEXT_PUBLIC_PAGE_IMAGE_FORMAT;
  else process.env.NEXT_PUBLIC_PAGE_IMAGE_FORMAT = originalFormat;
});

describe("pageImageExtension", () => {
  it("maps each supported MIME type to its key extension", () => {
    expect(pageImageExtension("image/webp")).toBe("webp");
    expect(pageImageExtension("image/png")).toBe("png");
  });

  it("covers every extension the completion endpoints will accept", () => {
    expect([...PAGE_IMAGE_EXTENSION_VALUES]).toEqual(["webp", "png"]);
  });
});

describe("parsePageImageMimeType", () => {
  it("accepts the two supported formats", () => {
    expect(parsePageImageMimeType("image/webp")).toBe("image/webp");
    expect(parsePageImageMimeType("image/png")).toBe("image/png");
  });

  it("rejects anything else a client might post", () => {
    for (const value of ["image/jpeg", "image/svg+xml", "text/html", "", 7, null, undefined, {}]) {
      expect(parsePageImageMimeType(value)).toBeNull();
    }
  });

  it("does not fall through to Object.prototype keys", () => {
    expect(parsePageImageMimeType("toString")).toBeNull();
    expect(parsePageImageMimeType("constructor")).toBeNull();
  });
});

describe("preferredPageImageMimeType", () => {
  it("defaults to WebP", () => {
    delete process.env.NEXT_PUBLIC_PAGE_IMAGE_FORMAT;
    expect(preferredPageImageMimeType()).toBe("image/webp");
  });

  it("falls back to PNG when a deployment pins the legacy format", () => {
    process.env.NEXT_PUBLIC_PAGE_IMAGE_FORMAT = " PNG ";
    expect(preferredPageImageMimeType()).toBe("image/png");
  });

  it("ignores an unrecognized value rather than rendering something unsupported", () => {
    process.env.NEXT_PUBLIC_PAGE_IMAGE_FORMAT = "avif";
    expect(preferredPageImageMimeType()).toBe("image/webp");
  });
});

describe("suffixPageImageKey", () => {
  it("inserts the suffix before the extension", () => {
    expect(suffixPageImageKey("a/b/figure-0.webp", "-uuid")).toBe("a/b/figure-0-uuid.webp");
    expect(suffixPageImageKey("a/b/option-0-1.png", "-uuid")).toBe("a/b/option-0-1-uuid.png");
  });

  it("appends when there is no extension to split on", () => {
    expect(suffixPageImageKey("a/b/figure-0", "-uuid")).toBe("a/b/figure-0-uuid");
  });
});
