import { describe, expect, it } from "vitest";
import {
  applyTranscriptEvent,
  createTranscriptBuffer,
  formatTranscriptBuffer,
  joinTextFragments,
  rebaseTranscriptBuffer,
  settleTranscriptBuffer,
} from "./transcript-merger";

describe("transcript-merger", () => {
  it("replaces provisional partial results in-place without duplicating text", () => {
    let buf = createTranscriptBuffer("");

    buf = applyTranscriptEvent(buf, {
      resultId: "seg-1",
      transcript: "Hello",
      isPartial: true,
    });
    expect(formatTranscriptBuffer(buf)).toBe("Hello");

    buf = applyTranscriptEvent(buf, {
      resultId: "seg-1",
      transcript: "Hello world",
      isPartial: true,
    });
    expect(formatTranscriptBuffer(buf)).toBe("Hello world");

    buf = applyTranscriptEvent(buf, {
      resultId: "seg-1",
      transcript: "Hello world, how are you?",
      isPartial: false,
    });
    expect(formatTranscriptBuffer(buf)).toBe("Hello world, how are you?");
    expect(buf.provisionalSegment).toBeNull();
    expect(buf.confirmedSegments).toEqual([
      { resultId: "seg-1", text: "Hello world, how are you?" },
    ]);
  });

  it("deduplicates repeated final events and ignores stale partials for an already finalized ResultId", () => {
    let buf = createTranscriptBuffer("");

    buf = applyTranscriptEvent(buf, {
      resultId: "seg-1",
      transcript: "First sentence.",
      isPartial: false,
    });
    // Duplicate final event with the same ResultId
    buf = applyTranscriptEvent(buf, {
      resultId: "seg-1",
      transcript: "First sentence.",
      isPartial: false,
    });
    // Late out-of-order partial for the already-finalized ResultId
    buf = applyTranscriptEvent(buf, {
      resultId: "seg-1",
      transcript: "First",
      isPartial: true,
    });

    expect(formatTranscriptBuffer(buf)).toBe("First sentence.");
    expect(buf.confirmedSegments).toHaveLength(1);
  });

  it("preserves existing typed text and appends multiple spoken segments with proper spacing", () => {
    let buf = createTranscriptBuffer("Typed prefix:");

    buf = applyTranscriptEvent(buf, {
      resultId: "seg-1",
      transcript: "spoken part one.",
      isPartial: false,
    });
    expect(formatTranscriptBuffer(buf)).toBe("Typed prefix: spoken part one.");

    buf = applyTranscriptEvent(buf, {
      resultId: "seg-2",
      transcript: "And part two",
      isPartial: true,
    });
    expect(formatTranscriptBuffer(buf)).toBe(
      "Typed prefix: spoken part one. And part two",
    );

    buf = applyTranscriptEvent(buf, {
      resultId: "seg-2",
      transcript: "And part two.",
      isPartial: false,
    });
    expect(formatTranscriptBuffer(buf)).toBe(
      "Typed prefix: spoken part one. And part two.",
    );
  });

  it("does not insert artificial spaces between Mandarin Chinese (zh-CN) characters", () => {
    expect(joinTextFragments("你好", "世界")).toBe("你好世界");
    expect(joinTextFragments("Hello", "world")).toBe("Hello world");
    expect(joinTextFragments("Hello ", "world")).toBe("Hello world");

    let buf = createTranscriptBuffer("请问");
    buf = applyTranscriptEvent(buf, {
      resultId: "zh-1",
      transcript: "这道题怎么做？",
      isPartial: false,
    });
    expect(formatTranscriptBuffer(buf)).toBe("请问这道题怎么做？");
  });

  it("settles remaining provisional text on stream close and supports rebasing on manual edit", () => {
    let buf = createTranscriptBuffer("Initial");
    buf = applyTranscriptEvent(buf, {
      resultId: "seg-1",
      transcript: "unfinalized tail",
      isPartial: true,
    });

    const settled = settleTranscriptBuffer(buf, { commitProvisional: true });
    expect(formatTranscriptBuffer(settled, { includeProvisional: false })).toBe(
      "Initial unfinalized tail",
    );

    const rebased = rebaseTranscriptBuffer("User edited text");
    const afterEdit = applyTranscriptEvent(rebased, {
      resultId: "seg-2",
      transcript: "more speech",
      isPartial: false,
    });
    expect(formatTranscriptBuffer(afterEdit)).toBe(
      "User edited text more speech",
    );
  });
});
