// Pure transcript state reducer for real-time Speech-to-Text (STT).
//
// Maintains three separate layers so partial revisions from Amazon Transcribe
// Streaming never duplicate text or corrupt what the user already typed:
//   1. `baseText`           — text present before recording started (or manually edited)
//   2. `confirmedSegments`  — finalized speech segments keyed by AWS `ResultId`
//   3. `provisionalSegment` — the in-flight `IsPartial: true` segment
//
// Join logic inserts a single space between Latin/alphanumeric tokens when the
// preceding piece does not end in whitespace, while avoiding artificial spaces
// between adjacent CJK characters (e.g. Mandarin Chinese `zh-CN`).

import type { SttTranscriptEvent } from "./types";

export interface TranscriptSegment {
  resultId: string;
  text: string;
}

export interface TranscriptBufferState {
  baseText: string;
  confirmedSegments: TranscriptSegment[];
  provisionalSegment: TranscriptSegment | null;
}

export function createTranscriptBuffer(
  initialBaseText = "",
): TranscriptBufferState {
  return {
    baseText: initialBaseText,
    confirmedSegments: [],
    provisionalSegment: null,
  };
}

// Matches CJK Unified Ideographs, Hiragana, Katakana, Hangul, and full-width
// CJK punctuation where spaces are not inserted between adjacent tokens.
const CJK_CHAR_RE =
  /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/;

const LEADING_PUNCTUATION_RE = /^[,.;:!?%)}\]]/;

/**
 * Join two non-empty text fragments with natural spacing:
 * - No extra space if `left` already ends with whitespace or `right` starts with whitespace
 * - No extra space if `right` starts with closing/clause punctuation
 * - No extra space when both the trailing char of `left` and leading char of `right` are CJK
 * - Otherwise insert a single space.
 */
export function joinTextFragments(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  if (/\s$/.test(left) || /^\s/.test(right)) {
    return `${left}${right}`;
  }
  if (LEADING_PUNCTUATION_RE.test(right)) {
    return `${left}${right}`;
  }
  const lastLeft = left[left.length - 1];
  const firstRight = right[0];
  if (CJK_CHAR_RE.test(lastLeft) && CJK_CHAR_RE.test(firstRight)) {
    return `${left}${right}`;
  }
  return `${left} ${right}`;
}

/**
 * Format the combined display text for the message input from a buffer state.
 * `includeProvisional` is true while recording, and false when producing a
 * strictly finalized transcript if a provisional fragment was never committed.
 */
export function formatTranscriptBuffer(
  state: TranscriptBufferState,
  options?: { includeProvisional?: boolean },
): string {
  const includeProvisional = options?.includeProvisional ?? true;
  let combined = state.baseText;

  for (const segment of state.confirmedSegments) {
    const trimmed = segment.text.trim();
    if (!trimmed) continue;
    combined = joinTextFragments(combined, trimmed);
  }

  if (includeProvisional && state.provisionalSegment) {
    const trimmed = state.provisionalSegment.text.trim();
    if (trimmed) {
      combined = joinTextFragments(combined, trimmed);
    }
  }

  return combined;
}

/**
 * Apply an incoming Amazon Transcribe Streaming `TranscriptEvent` result to the
 * buffer state.
 *
 * - If `isPartial` is true:
 *   - Ignore if `resultId` was already finalized (prevents late/out-of-order
 *     partial packets from re-adding an already committed segment).
 *   - Replace `provisionalSegment` in-place rather than appending.
 * - If `isPartial` is false (final segment):
 *   - Commit `transcript` under `resultId` in `confirmedSegments` (updating in
 *     place if `resultId` already exists, so duplicate final events are idempotent).
 *   - Clear `provisionalSegment` if it belonged to `resultId` (or any earlier partial).
 */
export function applyTranscriptEvent(
  state: TranscriptBufferState,
  event: SttTranscriptEvent,
): TranscriptBufferState {
  const resultId = event.resultId.trim();
  const text = event.transcript.trim();
  if (!resultId) return state;

  const existingConfirmedIndex = state.confirmedSegments.findIndex(
    (seg) => seg.resultId === resultId,
  );

  if (event.isPartial) {
    // Never resurrect a segment that has already been finalized.
    if (existingConfirmedIndex !== -1) {
      return state;
    }
    if (!text) {
      if (state.provisionalSegment?.resultId === resultId) {
        return { ...state, provisionalSegment: null };
      }
      return state;
    }
    return {
      ...state,
      provisionalSegment: { resultId, text },
    };
  }

  // Finalized result (`isPartial: false`)
  const nextConfirmed = [...state.confirmedSegments];
  if (text) {
    if (existingConfirmedIndex !== -1) {
      nextConfirmed[existingConfirmedIndex] = { resultId, text };
    } else {
      nextConfirmed.push({ resultId, text });
    }
  } else if (existingConfirmedIndex !== -1) {
    nextConfirmed.splice(existingConfirmedIndex, 1);
  }

  const nextProvisional =
    state.provisionalSegment?.resultId === resultId
      ? null
      : state.provisionalSegment;

  return {
    ...state,
    confirmedSegments: nextConfirmed,
    provisionalSegment: nextProvisional,
  };
}

/**
 * Commit any remaining provisional segment as final when a stream closes
 * cleanly after all audio was sent, or drop it if `commitUnfinalized` is false.
 */
export function settleTranscriptBuffer(
  state: TranscriptBufferState,
  options?: { commitProvisional?: boolean },
): TranscriptBufferState {
  const commitProvisional = options?.commitProvisional ?? false;
  if (!state.provisionalSegment) return state;

  if (!commitProvisional) {
    return {
      ...state,
      provisionalSegment: null,
    };
  }

  return applyTranscriptEvent(state, {
    resultId: state.provisionalSegment.resultId,
    transcript: state.provisionalSegment.text,
    isPartial: false,
  });
}

/**
 * Reconcile manual user edits made inside the textarea while STT is active:
 * resets `baseText` to the user's edited value and clears prior segments so
 * subsequent speech appends cleanly to what the user just edited.
 */
export function rebaseTranscriptBuffer(
  userEditedText: string,
): TranscriptBufferState {
  return {
    baseText: userEditedText,
    confirmedSegments: [],
    provisionalSegment: null,
  };
}
