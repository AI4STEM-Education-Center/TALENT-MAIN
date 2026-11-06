import { describe, expect, it } from "vitest";
import {
  decodeEventStreamMessage,
  encodeAudioEvent,
  encodeEventStreamMessage,
  parseTranscribeFrame,
} from "./aws-eventstream";
import { downsampleAndConvertToPcm16 } from "./audio-capture";

describe("aws-eventstream binary codec", () => {
  it("encodes and decodes an AudioEvent frame with valid prelude and message CRCs", () => {
    const pcm = new Int16Array([0, 16384, -16384, 32767, -32768]);
    const encoded = encodeAudioEvent(pcm);
    const decoded = decodeEventStreamMessage(encoded);

    expect(decoded.headers).toEqual({
      ":content-type": "application/octet-stream",
      ":event-type": "AudioEvent",
      ":message-type": "event",
    });
    expect(decoded.payload.byteLength).toBe(pcm.byteLength);
    const roundTrip = new Int16Array(
      decoded.payload.buffer,
      decoded.payload.byteOffset,
      decoded.payload.byteLength / 2,
    );
    expect([...roundTrip]).toEqual([...pcm]);
  });

  it("encodes an empty AudioEvent end-of-stream frame", () => {
    const eos = encodeAudioEvent(new Uint8Array(0));
    const decoded = decodeEventStreamMessage(eos);
    expect(decoded.headers[":event-type"]).toBe("AudioEvent");
    expect(decoded.payload.byteLength).toBe(0);
  });

  it("parses TranscriptEvent frames into partial and final SttTranscriptEvents", () => {
    const payloadJson = JSON.stringify({
      Transcript: {
        Results: [
          {
            ResultId: "res-101",
            IsPartial: true,
            LanguageCode: "en-US",
            Alternatives: [{ Transcript: "calculating velocity" }],
          },
        ],
      },
    });
    const frame = encodeEventStreamMessage(
      {
        ":content-type": "application/json",
        ":event-type": "TranscriptEvent",
        ":message-type": "event",
      },
      new TextEncoder().encode(payloadJson),
    );

    const parsed = parseTranscribeFrame(frame);
    expect(parsed).toEqual({
      kind: "transcript",
      events: [
        {
          resultId: "res-101",
          transcript: "calculating velocity",
          isPartial: true,
          languageCode: "en-US",
        },
      ],
    });
  });

  it("parses exception frames from Amazon Transcribe", () => {
    const frame = encodeEventStreamMessage(
      {
        ":exception-type": "BadRequestException",
        ":message-type": "exception",
      },
      new TextEncoder().encode(
        JSON.stringify({ Message: "Audio stream timed out" }),
      ),
    );

    const parsed = parseTranscribeFrame(frame);
    expect(parsed).toEqual({
      kind: "exception",
      exceptionType: "BadRequestException",
      message: "Audio stream timed out",
    });
  });

  it("rejects corrupted frames when a CRC check fails", () => {
    const encoded = encodeAudioEvent(new Uint8Array([1, 2, 3, 4]));
    encoded[encoded.length - 1] ^= 0xff;
    expect(() => decodeEventStreamMessage(encoded)).toThrow(/CRC mismatch/);
  });
});

describe("downsampleAndConvertToPcm16", () => {
  it("downsamples 48 kHz and 44.1 kHz Float32 audio to 16 kHz signed 16-bit PCM", () => {
    const input48k = new Float32Array(4800).fill(0.5);
    const out16k = downsampleAndConvertToPcm16(input48k, 48_000, 16_000);
    expect(out16k.length).toBe(1600);
    expect(out16k[0]).toBe(Math.round(0.5 * 0x7fff));

    const input44k = new Float32Array(4410).fill(-1.5); // clamps at -1.0
    const outFrom44k = downsampleAndConvertToPcm16(input44k, 44_100, 16_000);
    expect(outFrom44k.length).toBe(1600);
    expect(outFrom44k[0]).toBe(-32768);
  });
});
