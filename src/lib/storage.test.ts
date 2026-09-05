import { describe, it, expect, afterEach } from "vitest";
import {
  getMaxUploadBytes,
  maxDerivedPageBytes,
  sanitizeFilename,
  buildStorageKey,
  buildPageStorageKey,
  materialPrefixFromStorageKey,
  getS3Config,
  getAwsCredentials,
  quizExtractionScope,
  buildQuizExtractionPdfKey,
  buildQuizExtractionPageKey,
  buildQuizExtractionFigureKey,
  buildQuizExtractionOptionImageKey,
  buildSimulationKey,
  getS3KeyPrefix,
  quizExtractionPrefix,
} from "./storage";
import { TEST_AWS_ENV } from "../../vitest.setup";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

// Restore the shared baseline rather than deleting the AWS variables: vitest
// runs spec files serially in one worker (fileParallelism: false), so unsetting
// them here would leave later files without the credentials storage.ts now
// requires.
afterEach(() => {
  delete process.env.LEARNING_MATERIAL_MAX_BYTES;
  delete process.env.S3_KEY_PREFIX;
  delete process.env.AWS_SESSION_TOKEN;
  Object.assign(process.env, TEST_AWS_ENV);
});

describe("sanitizeFilename", () => {
  it("strips directory components", () => {
    expect(sanitizeFilename("/etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\me\\file.pdf")).toBe("file.pdf");
  });

  it("replaces unsafe characters with underscores", () => {
    expect(sanitizeFilename("my file (final)!.pdf")).toBe(
      "my_file__final__.pdf",
    );
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
      "learning-materials/t1/c1/m1/notes.pdf",
    );
  });

  it("strips path-traversal segments from the original name", () => {
    // The leading `../` is part of the path prefix, which sanitizeFilename
    // removes entirely (everything up to the last slash), leaving just the base.
    expect(buildStorageKey("t1", "c1", "m1", "../evil.pdf")).toBe(
      "learning-materials/t1/c1/m1/evil.pdf",
    );
  });

  it("replaces unsafe characters in the base name within the key", () => {
    expect(buildStorageKey("t1", "c1", "m1", "weird name@2.pdf")).toBe(
      "learning-materials/t1/c1/m1/weird_name_2.pdf",
    );
  });

  it("builds a deterministic page key", () => {
    expect(buildPageStorageKey("t1", "c1", "m1", 3)).toBe(
      "learning-materials/t1/c1/m1/pages/page-3.png",
    );
  });

  it("takes the extension from the negotiated page image format", () => {
    expect(buildPageStorageKey("t1", "c1", "m1", 3, "webp")).toBe(
      "learning-materials/t1/c1/m1/pages/page-3.webp",
    );
  });
});

describe("S3 key namespace", () => {
  it("normalizes a configured prefix and applies it to every managed key family", () => {
    process.env.S3_KEY_PREFIX = "/dev//";

    expect(getS3KeyPrefix()).toBe("dev/");
    expect(buildStorageKey("t1", "c1", "m1", "notes.pdf")).toBe(
      "dev/learning-materials/t1/c1/m1/notes.pdf",
    );
    expect(buildPageStorageKey("t1", "c1", "m1", 1)).toBe(
      "dev/learning-materials/t1/c1/m1/pages/page-1.png",
    );
    expect(buildQuizExtractionPdfKey(null, "q1", "e1", "quiz.pdf")).toBe(
      "dev/quiz-extractions/pool/q1/e1/quiz.pdf",
    );
    expect(buildQuizExtractionPageKey(null, "q1", "e1", 1)).toBe(
      "dev/quiz-extractions/pool/q1/e1/pages/page-1.png",
    );
    expect(buildQuizExtractionFigureKey(null, "q1", "e1", 0)).toBe(
      "dev/quiz-extractions/pool/q1/e1/figures/figure-0.png",
    );
    expect(buildQuizExtractionOptionImageKey(null, "q1", "e1", 0, 1)).toBe(
      "dev/quiz-extractions/pool/q1/e1/figures/option-0-1.png",
    );
    expect(buildSimulationKey(null, "q1", "question1", 1)).toBe(
      "dev/simulations/pool/q1/question1/v1.html",
    );
  });

  it("rejects unsafe namespace segments", () => {
    process.env.S3_KEY_PREFIX = "../dev";
    expect(() => getS3KeyPrefix()).toThrow(/safe path segments/);
  });
});

describe("materialPrefixFromStorageKey", () => {
  it("returns the prefix up to and including the last slash for an original key", () => {
    const key = buildStorageKey("t1", "c1", "m1", "notes.pdf");
    expect(materialPrefixFromStorageKey(key)).toBe(
      "learning-materials/t1/c1/m1/",
    );
  });

  it("returns the pages prefix for a page key (not the material root)", () => {
    const key = buildPageStorageKey("t1", "c1", "m1", 2);
    expect(materialPrefixFromStorageKey(key)).toBe(
      "learning-materials/t1/c1/m1/pages/",
    );
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

describe("quizExtractionScope", () => {
  it("uses the teacherId when present", () => {
    expect(quizExtractionScope("t1")).toBe("t1");
  });

  it("falls back to 'pool' for null (admin-owned) quizzes", () => {
    expect(quizExtractionScope(null)).toBe("pool");
  });
});

describe("buildQuizExtraction* keys", () => {
  it("builds a teacher-scoped PDF key with a sanitized filename", () => {
    expect(buildQuizExtractionPdfKey("t1", "qz1", "ex1", "Mid Term!.pdf")).toBe(
      "quiz-extractions/t1/qz1/ex1/Mid_Term_.pdf",
    );
  });

  it("scopes pool PDFs under 'pool'", () => {
    expect(buildQuizExtractionPdfKey(null, "qz1", "ex1", "exam.pdf")).toBe(
      "quiz-extractions/pool/qz1/ex1/exam.pdf",
    );
  });

  it("builds deterministic page and figure keys", () => {
    expect(buildQuizExtractionPageKey("t1", "qz1", "ex1", 4)).toBe(
      "quiz-extractions/t1/qz1/ex1/pages/page-4.png",
    );
    expect(buildQuizExtractionFigureKey("t1", "qz1", "ex1", 2)).toBe(
      "quiz-extractions/t1/qz1/ex1/figures/figure-2.png",
    );
  });

  it("carries the negotiated image format into page, figure and option keys", () => {
    expect(buildQuizExtractionPageKey("t1", "qz1", "ex1", 4, "webp")).toBe(
      "quiz-extractions/t1/qz1/ex1/pages/page-4.webp",
    );
    expect(buildQuizExtractionFigureKey("t1", "qz1", "ex1", 2, "webp")).toBe(
      "quiz-extractions/t1/qz1/ex1/figures/figure-2.webp",
    );
    expect(
      buildQuizExtractionOptionImageKey("t1", "qz1", "ex1", 0, 1, "webp"),
    ).toBe("quiz-extractions/t1/qz1/ex1/figures/option-0-1.webp");
  });
});

describe("quizExtractionPrefix", () => {
  it("returns the extraction directory covering the PDF, pages and figures", () => {
    const pdfKey = buildQuizExtractionPdfKey("t1", "qz1", "ex1", "exam.pdf");
    const prefix = quizExtractionPrefix(pdfKey);
    expect(prefix).toBe("quiz-extractions/t1/qz1/ex1/");
    // Pages and figures of the same extraction sit under that prefix.
    expect(
      buildQuizExtractionPageKey("t1", "qz1", "ex1", 1).startsWith(prefix),
    ).toBe(true);
    expect(
      buildQuizExtractionFigureKey("t1", "qz1", "ex1", 1).startsWith(prefix),
    ).toBe(true);
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

describe("maxDerivedPageBytes", () => {
  const MB = 1024 * 1024;

  it("keeps the old flat allowance for short documents", () => {
    // 4x the 50 MB single-file limit, as before — a 3-page handout never needed
    // more, and nothing that used to upload should start failing.
    expect(maxDerivedPageBytes(3)).toBe(4 * DEFAULT_MAX_BYTES);
  });

  it("scales with page count once the flat allowance would bind", () => {
    // The regression this exists for: a 100-page scan renders to far more than
    // 200 MB of PNG while every individual page is comfortably legal, and the
    // flat cap only rejected it after all 100 pages had been uploaded.
    expect(maxDerivedPageBytes(100)).toBe(400 * MB);
    expect(maxDerivedPageBytes(100)).toBeGreaterThan(4 * DEFAULT_MAX_BYTES);
  });

  it("never returns less than the flat allowance", () => {
    for (const pages of [0, 1, 10, 50, 100]) {
      expect(maxDerivedPageBytes(pages)).toBeGreaterThanOrEqual(
        4 * DEFAULT_MAX_BYTES,
      );
    }
  });

  it("tracks a configured per-file limit", () => {
    process.env.LEARNING_MATERIAL_MAX_BYTES = String(10 * MB);
    expect(maxDerivedPageBytes(1)).toBe(40 * MB);
    delete process.env.LEARNING_MATERIAL_MAX_BYTES;
  });
});

describe("getAwsCredentials", () => {
  it("returns the static key pair from the environment", () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIA_EXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    expect(getAwsCredentials()).toEqual({
      accessKeyId: "AKIA_EXAMPLE",
      secretAccessKey: "secret",
    });
  });

  it("includes a session token only when one is set", () => {
    process.env.AWS_SESSION_TOKEN = "temp-token";
    expect(getAwsCredentials()).toMatchObject({ sessionToken: "temp-token" });
  });

  // The whole point of the change: no silent fall-through to an EC2 instance
  // role, so an incomplete .env must fail loudly on either half of the pair.
  it("throws when either half of the key pair is missing", () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    expect(() => getAwsCredentials()).toThrow(
      /AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/,
    );

    process.env.AWS_ACCESS_KEY_ID = "AKIA_EXAMPLE";
    delete process.env.AWS_SECRET_ACCESS_KEY;
    expect(() => getAwsCredentials()).toThrow(
      /AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/,
    );
  });

  it("treats whitespace-only values as missing", () => {
    process.env.AWS_ACCESS_KEY_ID = "   ";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    expect(() => getAwsCredentials()).toThrow(
      /AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/,
    );
  });
});
