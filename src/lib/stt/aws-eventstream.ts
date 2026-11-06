// Pure TypeScript encoder and decoder for the AWS `vnd.amazon.eventstream`
// binary framing protocol used by Amazon Transcribe Streaming WebSockets.
//
// Reference:
// https://docs.aws.amazon.com/transcribe/latest/dg/event-stream.html
//
// Frame layout (all integers big-endian):
//   [0..3]                 total byte length (uint32)
//   [4..7]                 headers byte length (uint32)
//   [8..11]                prelude CRC32 (uint32 over bytes 0..7)
//   [12..12+H-1]           headers
//   [12+H..total-5]        payload
//   [total-4..total-1]     message CRC32 (uint32 over bytes 0..total-5)
//
// Header layout (string header, value type = 7):
//   [0]                    header name byte length (uint8)
//   [1..N]                 header name UTF-8 bytes
//   [N+1]                  header value type (7 = string)
//   [N+2..N+3]             value byte length (uint16 big-endian)
//   [N+4..N+4+M-1]         value UTF-8 bytes

import type { SttTranscriptEvent } from "./types";

const HEADER_VALUE_STRING = 7;

// Precomputed standard IEEE 802.3 CRC32 lookup table.
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8");

function encodeStringHeader(name: string, value: string): Uint8Array {
  const nameBytes = utf8Encoder.encode(name);
  const valueBytes = utf8Encoder.encode(value);
  const out = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
  const view = new DataView(out.buffer);
  out[0] = nameBytes.length;
  out.set(nameBytes, 1);
  const offset = 1 + nameBytes.length;
  out[offset] = HEADER_VALUE_STRING;
  view.setUint16(offset + 1, valueBytes.length, false);
  out.set(valueBytes, offset + 3);
  return out;
}

export function encodeEventStreamMessage(
  headers: Record<string, string>,
  payload: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const encodedHeaderChunks = Object.entries(headers).map(([k, v]) =>
    encodeStringHeader(k, v),
  );
  const headersByteLength = encodedHeaderChunks.reduce(
    (sum, chunk) => sum + chunk.length,
    0,
  );
  const totalByteLength = 12 + headersByteLength + payload.length + 4;

  const message = new Uint8Array(totalByteLength);
  const view = new DataView(message.buffer);

  view.setUint32(0, totalByteLength, false);
  view.setUint32(4, headersByteLength, false);
  view.setUint32(8, crc32(message.subarray(0, 8)), false);

  let cursor = 12;
  for (const chunk of encodedHeaderChunks) {
    message.set(chunk, cursor);
    cursor += chunk.length;
  }

  message.set(payload, cursor);
  cursor += payload.length;

  view.setUint32(cursor, crc32(message.subarray(0, cursor)), false);
  return message;
}

const AUDIO_EVENT_HEADERS = {
  ":content-type": "application/octet-stream",
  ":event-type": "AudioEvent",
  ":message-type": "event",
} as const;

/**
 * Wrap raw 16-bit little-endian PCM bytes in an Amazon Transcribe `AudioEvent`
 * binary frame. Passing an empty `Uint8Array(0)` produces the end-of-stream
 * frame that tells Transcribe to flush and close the stream.
 */
export function encodeAudioEvent(
  pcmBytes: Uint8Array | Int16Array,
): Uint8Array<ArrayBuffer> {
  const payload =
    pcmBytes instanceof Uint8Array
      ? pcmBytes
      : new Uint8Array(
          pcmBytes.buffer,
          pcmBytes.byteOffset,
          pcmBytes.byteLength,
        );
  return encodeEventStreamMessage(AUDIO_EVENT_HEADERS, payload);
}

export interface DecodedEventStreamMessage {
  headers: Record<string, string>;
  payload: Uint8Array;
}

/**
 * Decode and CRC-verify an incoming `vnd.amazon.eventstream` binary message.
 */
export function decodeEventStreamMessage(
  input: ArrayBuffer | Uint8Array,
): DecodedEventStreamMessage {
  const bytes =
    input instanceof Uint8Array
      ? input
      : new Uint8Array(input, 0, input.byteLength);

  if (bytes.byteLength < 16) {
    throw new Error("Invalid event-stream frame: shorter than 16 bytes");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const totalLength = view.getUint32(0, false);
  const headersLength = view.getUint32(4, false);
  const preludeCrc = view.getUint32(8, false);

  if (totalLength !== bytes.byteLength) {
    throw new Error(
      `Invalid event-stream frame: expected ${totalLength} bytes, got ${bytes.byteLength}`,
    );
  }
  if (12 + headersLength + 4 > totalLength) {
    throw new Error("Invalid event-stream frame: headers exceed frame size");
  }

  const computedPreludeCrc = crc32(bytes.subarray(0, 8));
  if (computedPreludeCrc !== preludeCrc) {
    throw new Error("Event-stream prelude CRC mismatch");
  }

  const messageCrc = view.getUint32(totalLength - 4, false);
  const computedMessageCrc = crc32(bytes.subarray(0, totalLength - 4));
  if (computedMessageCrc !== messageCrc) {
    throw new Error("Event-stream message CRC mismatch");
  }

  const headers: Record<string, string> = {};
  let cursor = 12;
  const headersEnd = 12 + headersLength;

  while (cursor < headersEnd) {
    const nameLen = bytes[cursor];
    cursor += 1;
    if (cursor + nameLen > headersEnd) {
      throw new Error("Invalid event-stream header name length");
    }
    const name = utf8Decoder.decode(bytes.subarray(cursor, cursor + nameLen));
    cursor += nameLen;

    const valueType = bytes[cursor];
    cursor += 1;

    switch (valueType) {
      case 0: // boolean true
        headers[name] = "true";
        break;
      case 1: // boolean false
        headers[name] = "false";
        break;
      case 2: // byte
        headers[name] = String(view.getInt8(cursor));
        cursor += 1;
        break;
      case 3: // short
        headers[name] = String(view.getInt16(cursor, false));
        cursor += 2;
        break;
      case 4: // integer
        headers[name] = String(view.getInt32(cursor, false));
        cursor += 4;
        break;
      case 5: // long
      case 8: // timestamp
        cursor += 8;
        break;
      case 6: {
        // byte array
        const len = view.getUint16(cursor, false);
        cursor += 2 + len;
        break;
      }
      case HEADER_VALUE_STRING: {
        const len = view.getUint16(cursor, false);
        cursor += 2;
        if (cursor + len > headersEnd) {
          throw new Error("Invalid event-stream string header length");
        }
        headers[name] = utf8Decoder.decode(bytes.subarray(cursor, cursor + len));
        cursor += len;
        break;
      }
      case 9: // uuid
        cursor += 16;
        break;
      default:
        throw new Error(`Unsupported event-stream header type: ${valueType}`);
    }
  }

  const payload = bytes.subarray(headersEnd, totalLength - 4);
  return { headers, payload };
}

interface AwsTranscribeAlternative {
  Transcript?: string;
}

interface AwsTranscribeResult {
  ResultId?: string;
  IsPartial?: boolean;
  LanguageCode?: string;
  Alternatives?: AwsTranscribeAlternative[];
}

interface AwsTranscriptPayload {
  Transcript?: {
    Results?: AwsTranscribeResult[];
  };
  Message?: string;
  message?: string;
}

export type ParsedTranscribeFrame =
  | { kind: "transcript"; events: SttTranscriptEvent[] }
  | { kind: "exception"; exceptionType: string; message: string }
  | { kind: "noop" };

/**
 * Parse a decoded AWS Transcribe WebSocket binary message into structured
 * transcript events or an exception error.
 */
export function parseTranscribeFrame(
  input: ArrayBuffer | Uint8Array,
): ParsedTranscribeFrame {
  const { headers, payload } = decodeEventStreamMessage(input);
  const messageType = headers[":message-type"];

  if (messageType === "exception" || messageType === "error") {
    const exceptionType =
      headers[":exception-type"] ?? headers[":error-code"] ?? "TranscribeError";
    let message = exceptionType;
    if (payload.byteLength > 0) {
      try {
        const parsed = JSON.parse(
          utf8Decoder.decode(payload),
        ) as AwsTranscriptPayload;
        message = parsed.Message || parsed.message || message;
      } catch {
        message = utf8Decoder.decode(payload) || message;
      }
    }
    return { kind: "exception", exceptionType, message };
  }

  if (
    messageType === "event" &&
    headers[":event-type"] === "TranscriptEvent" &&
    payload.byteLength > 0
  ) {
    const body = JSON.parse(
      utf8Decoder.decode(payload),
    ) as AwsTranscriptPayload;
    const results = body.Transcript?.Results ?? [];
    const events: SttTranscriptEvent[] = [];
    for (const res of results) {
      const resultId = res.ResultId;
      if (!resultId) continue;
      const transcript = res.Alternatives?.[0]?.Transcript ?? "";
      events.push({
        resultId,
        transcript,
        isPartial: Boolean(res.IsPartial),
        languageCode: res.LanguageCode,
      });
    }
    return { kind: "transcript", events };
  }

  return { kind: "noop" };
}
