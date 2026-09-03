import { describe, it, expect, vi, beforeEach } from "vitest";

// Isolate the URL-signing logic from real storage by mocking the module.
vi.mock("@/lib/storage", () => ({
  signObjectReadUrl: vi.fn(),
  getS3Config: vi.fn(),
}));

import { presignQuestionFigure, attachFigureUrls } from "./question-figures";
import { signObjectReadUrl, getS3Config } from "@/lib/storage";

const mockPresign = vi.mocked(signObjectReadUrl);
const mockConfig = vi.mocked(getS3Config);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("presignQuestionFigure", () => {
  it("returns null and never presigns when there is no figure key", async () => {
    expect(
      await presignQuestionFigure({
        figureStorageKey: null,
        figureBucket: null,
      }),
    ).toBeNull();
    expect(mockPresign).not.toHaveBeenCalled();
  });

  it("presigns against the row's explicit bucket for one hour", async () => {
    mockPresign.mockResolvedValue("https://signed.example/figure.png");
    const url = await presignQuestionFigure({
      figureStorageKey: "k.png",
      figureBucket: "row-bucket",
    });
    expect(url).toBe("https://signed.example/figure.png");
    expect(mockPresign).toHaveBeenCalledWith("row-bucket", "k.png", 3600);
  });

  it("falls back to the configured default bucket when the row has none", async () => {
    mockConfig.mockReturnValue({
      bucket: "default-bucket",
      region: "us-east-1",
    });
    mockPresign.mockResolvedValue("https://signed.example/figure.png");
    await presignQuestionFigure({
      figureStorageKey: "k.png",
      figureBucket: null,
    });
    expect(mockPresign).toHaveBeenCalledWith("default-bucket", "k.png", 3600);
  });

  it("drops the figure (returns null) when presigning rejects", async () => {
    mockPresign.mockRejectedValue(new Error("object gone"));
    expect(
      await presignQuestionFigure({
        figureStorageKey: "k.png",
        figureBucket: "b",
      }),
    ).toBeNull();
  });

  it("drops the figure when S3 config is missing for a bucketless row", async () => {
    mockConfig.mockImplementation(() => {
      throw new Error("AWS not configured");
    });
    expect(
      await presignQuestionFigure({
        figureStorageKey: "k.png",
        figureBucket: null,
      }),
    ).toBeNull();
  });
});

describe("attachFigureUrls", () => {
  it("swaps key/bucket for a presigned figureUrl and passes other fields through", async () => {
    mockPresign.mockResolvedValue("https://signed.example/figure.png");
    const out = await attachFigureUrls([
      {
        id: "q1",
        text: "Question one",
        figureStorageKey: "k.png",
        figureBucket: "b",
      },
    ]);
    expect(out).toEqual([
      {
        id: "q1",
        text: "Question one",
        figureUrl: "https://signed.example/figure.png",
      },
    ]);
    expect(out[0]).not.toHaveProperty("figureStorageKey");
    expect(out[0]).not.toHaveProperty("figureBucket");
  });

  it("sets figureUrl to null for figureless rows", async () => {
    const out = await attachFigureUrls([
      {
        id: "q2",
        text: "no figure",
        figureStorageKey: null,
        figureBucket: null,
      },
    ]);
    expect(out[0].figureUrl).toBeNull();
    expect(mockPresign).not.toHaveBeenCalled();
  });

  it("returns an empty array unchanged", async () => {
    expect(await attachFigureUrls([])).toEqual([]);
  });
});
