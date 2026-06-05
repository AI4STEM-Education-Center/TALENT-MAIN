import { describe, it, expect, afterEach } from "vitest";
import {
  getMaxUploadBytes,
  sanitizeFilename,
  buildStorageKey,
  buildPageStorageKey,
  materialPrefixFromStorageKey,
  getS3Config,
} from "./storage";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

afterEach(() => {
  delete process.env.LEARNING_MATERIAL_MAX_BYTES;
  delete process.env.AWS_S3_BUCKET;
  delete process.env.AWS_REGION;
});

describe("sanitizeFilename", () => {
  it("strips directory components", () => {
    expect(sanitizeFilename("/etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\me\\file.pdf")).toBe("file.pdf");
  });

  it("replaces unsafe characters with underscores", () => {
    expect(sanitizeFilename("my file (final)!.pdf")).toBe("my_file__final__.pdf");
  });

  it("keeps dots, dashes and underscores", () => {
    expect(sanitizeFilename("a-b_c.d.pdf")).toBe("a-b_c.d.pdf");
  });

  it("caps the length at 200 characters", () => {
    expect(sanitizeFilename("a".repeat(500))).toHaveLength(200);
  });

  it("falls back to 'file' when nothing usable remains", () => {
    expect(sanitizeFilename("/path/to/")).toBe("file");
  });
});

describe("buildStorageKey / buildPageStorageKey", () => {
  it("builds an object key under the teacher/class/material prefix", () => {
    expect(buildStorageKey("t1", "c1", "m1", "notes.pdf")).toBe(
      "learning-materials/t1/c1/m1/notes.pdf"
    );
  });

  it("strips path-traversal segments from the original name", () => {
    // The leading `../` is part of the path prefix, which sanitizeFilename
    // removes entirely (everything up to the last slash), leaving just the base.
    expect(buildStorageKey("t1", "c1", "m1", "../evil.pdf")).toBe(
      "learning-materials/t1/c1/m1/evil.pdf"
    );
  });

  it("replaces unsafe characters in the base name within the key", () => {
    expect(buildStorageKey("t1", "c1", "m1", "weird name@2.pdf")).toBe(
      "learning-materials/t1/c1/m1/weird_name_2.pdf"
    );
  });

  it("builds a deterministic page key", () => {
    expect(buildPageStorageKey("t1", "c1", "m1", 3)).toBe(
      "learning-materials/t1/c1/m1/pages/page-3.png"
    );
  });
});

describe("materialPrefixFromStorageKey", () => {
  it("returns the prefix up to and including the last slash for an original key", () => {
    const key = buildStorageKey("t1", "c1", "m1", "notes.pdf");
    expect(materialPrefixFromStorageKey(key)).toBe("learning-materials/t1/c1/m1/");
  });

  it("returns the pages prefix for a page key (not the material root)", () => {
    const key = buildPageStorageKey("t1", "c1", "m1", 2);
    expect(materialPrefixFromStorageKey(key)).toBe("learning-materials/t1/c1/m1/pages/");
  });
});

describe("getMaxUploadBytes", () => {
  it("returns the default when unset", () => {
    expect(getMaxUploadBytes()).toBe(DEFAULT_MAX_BYTES);
  });

  it("honours a valid override", () => {
    process.env.LEARNING_MATERIAL_MAX_BYTES = "1024";
    expect(getMaxUploadBytes()).toBe(1024);
  });

  it("falls back to default for non-positive or non-numeric values", () => {
    process.env.LEARNING_MATERIAL_MAX_BYTES = "0";
    expect(getMaxUploadBytes()).toBe(DEFAULT_MAX_BYTES);
    process.env.LEARNING_MATERIAL_MAX_BYTES = "not-a-number";
    expect(getMaxUploadBytes()).toBe(DEFAULT_MAX_BYTES);
  });
});

describe("getS3Config", () => {
  it("returns bucket and region when both are set", () => {
    process.env.AWS_S3_BUCKET = "my-bucket";
    process.env.AWS_REGION = "us-east-1";
    expect(getS3Config()).toEqual({ bucket: "my-bucket", region: "us-east-1" });
  });

  it("throws when configuration is incomplete", () => {
    process.env.AWS_S3_BUCKET = "my-bucket";
    delete process.env.AWS_REGION;
    expect(() => getS3Config()).toThrow(/AWS_S3_BUCKET and AWS_REGION/);
  });
});
