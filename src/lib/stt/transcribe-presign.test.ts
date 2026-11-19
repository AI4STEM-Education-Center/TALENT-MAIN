import { describe, expect, it } from "vitest";
import {
  presignTranscribeStreamingUrl,
  resolveTranscribeRegion,
} from "./transcribe-presign";
import { DEFAULT_STT_SETTINGS } from "./types";

const TEST_CREDS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

describe("presignTranscribeStreamingUrl", () => {
  it("generates a deterministic SigV4 presigned WebSocket URL for en-US with medium partial stabilization", () => {
    const res = presignTranscribeStreamingUrl({
      settings: {
        ...DEFAULT_STT_SETTINGS,
        region: "us-east-1",
        languageCode: "en-US",
        identifyLanguage: false,
        enablePartialResultsStabilization: true,
        partialResultsStability: "medium",
      },
      credentials: TEST_CREDS,
      now: new Date("2026-11-06T12:00:00Z"),
    });

    expect(res.region).toBe("us-east-1");
    expect(res.sampleRate).toBe(16000);
    expect(res.languageCode).toBe("en-US");
    expect(res.identifyLanguage).toBe(false);
    expect(res.url).toMatch(
      /^wss:\/\/transcribestreaming\.us-east-1\.amazonaws\.com:8443\/stream-transcription-websocket\?/,
    );
    expect(res.url).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
    expect(res.url).toContain("language-code=en-US");
    expect(res.url).toContain("media-encoding=pcm");
    expect(res.url).toContain("sample-rate=16000");
    expect(res.url).toContain("enable-partial-results-stabilization=true");
    expect(res.url).toContain("partial-results-stability=medium");
    expect(res.url).toMatch(/&X-Amz-Signature=[0-9a-f]{64}$/);
  });

  it("supports Mandarin Chinese (zh-CN) and automatic multi-language identification", () => {
    const res = presignTranscribeStreamingUrl({
      settings: {
        ...DEFAULT_STT_SETTINGS,
        region: "us-east-1",
        languageCode: "zh-CN",
        identifyLanguage: true,
        languageOptions: ["en-US", "zh-CN"],
      },
      credentials: TEST_CREDS,
      now: new Date("2026-11-06T12:00:00Z"),
    });

    expect(res.identifyLanguage).toBe(true);
    expect(res.url).toContain("identify-language=true");
    expect(res.url).toContain("language-options=en-US%2Czh-CN");
    expect(res.url).toContain("preferred-language=zh-CN");
    expect(res.url).not.toContain("language-code=");
  });

  it("rejects unsupported AWS regions", () => {
    expect(() => resolveTranscribeRegion("mars-north-1")).toThrow(
      /does not support Amazon Transcribe Streaming/,
    );
  });
});
