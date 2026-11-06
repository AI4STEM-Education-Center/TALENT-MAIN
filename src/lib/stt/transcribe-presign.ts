// Server-side SigV4 presigned URL generator for Amazon Transcribe Streaming
// WebSocket (`wss://transcribestreaming.<region>.amazonaws.com:8443/stream-transcription-websocket`).
//
// Reference:
// https://docs.aws.amazon.com/transcribe/latest/dg/websocket.html
//
// Uses Node's built-in `node:crypto` module, so presigning takes <1ms of CPU,
// needs no external packages, and never logs or persists the signed URL.

import { createHash, createHmac } from "node:crypto";
import { getAwsCredentials } from "@/lib/storage";
import {
  isAwsTranscribeRegion,
  isSttLanguageCode,
  isSttPartialStability,
  type SttSettings,
} from "./types";

const SERVICE = "transcribe";
const ALGORITHM = "AWS4-HMAC-SHA256";
const DEFAULT_SAMPLE_RATE = 16_000;
const DEFAULT_EXPIRES_SEC = 60;
const EMPTY_PAYLOAD_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function formatAmzDate(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

/**
 * RFC 3986 percent-encoding required by AWS SigV4 canonical query strings.
 */
function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function buildCanonicalQueryString(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${rfc3986Encode(key)}=${rfc3986Encode(params[key])}`)
    .join("&");
}

export interface PresignTranscribeInput {
  settings: SttSettings;
  sampleRate?: number;
  expiresInSec?: number;
  now?: Date;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}

export interface PresignTranscribeResult {
  url: string;
  region: string;
  sampleRate: number;
  languageCode: string;
  identifyLanguage: boolean;
  expiresIn: number;
}

/**
 * Resolve the AWS region for Transcribe Streaming from the admin-configured
 * `settings.region` or the deployment's `AWS_REGION` environment variable, and
 * verify that Amazon Transcribe Streaming supports that region.
 */
export function resolveTranscribeRegion(configuredRegion?: string): string {
  const region = (
    configuredRegion?.trim() ||
    process.env.AWS_REGION?.trim() ||
    ""
  ).toLowerCase();

  if (!region) {
    throw new Error(
      "Amazon Transcribe Streaming requires an AWS region (configure one in Admin > AI Config or set AWS_REGION).",
    );
  }
  if (!isAwsTranscribeRegion(region)) {
    throw new Error(
      `AWS region "${region}" does not support Amazon Transcribe Streaming WebSockets.`,
    );
  }
  return region;
}

/**
 * Create a short-lived SigV4-presigned `wss://` URL for Amazon Transcribe
 * Streaming.
 */
export function presignTranscribeStreamingUrl(
  input: PresignTranscribeInput,
): PresignTranscribeResult {
  const { settings } = input;
  const region = resolveTranscribeRegion(settings.region);
  const creds = input.credentials ?? getAwsCredentials();
  const sampleRate = input.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const expiresIn = Math.min(
    300,
    Math.max(15, Math.trunc(input.expiresInSec ?? DEFAULT_EXPIRES_SEC)),
  );
  const { amzDate, dateStamp } = formatAmzDate(input.now ?? new Date());

  const host = `transcribestreaming.${region}.amazonaws.com:8443`;
  const canonicalUri = "/stream-transcription-websocket";
  const credentialScope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;

  const queryParams: Record<string, string> = {
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${creds.accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": "host",
    "media-encoding": "pcm",
    "sample-rate": String(sampleRate),
  };

  if (creds.sessionToken) {
    queryParams["X-Amz-Security-Token"] = creds.sessionToken;
  }

  // Language selection: either automatic multi-language identification or a
  // single pinned language code.
  // AWS Transcribe requires at most one dialect per base language (e.g., not
  // both en-US and en-GB) in `language-options`, and requires `preferred-language`
  // to be a member of `language-options`.
  const preferredLang = isSttLanguageCode(settings.languageCode)
    ? settings.languageCode
    : "en-US";
  const prefFamily = preferredLang.split("-")[0].toLowerCase();
  const rawOptions = (settings.languageOptions ?? [])
    .filter(isSttLanguageCode)
    .map((c) =>
      c.split("-")[0].toLowerCase() === prefFamily ? preferredLang : c,
    );
  const candidatesWithPreferred = rawOptions.includes(preferredLang)
    ? rawOptions
    : [preferredLang, ...rawOptions];

  const seenBaseLangs = new Set<string>();
  const validOptions: string[] = [];
  for (const code of candidatesWithPreferred) {
    const base = code.split("-")[0].toLowerCase();
    if (seenBaseLangs.has(base)) continue;
    seenBaseLangs.add(base);
    validOptions.push(code);
  }

  const useIdentifyLanguage =
    settings.identifyLanguage && validOptions.length >= 2;

  if (useIdentifyLanguage) {
    queryParams["identify-language"] = "true";
    queryParams["language-options"] = validOptions.join(",");
    if (validOptions.includes(preferredLang)) {
      queryParams["preferred-language"] = preferredLang;
    }
  } else {
    queryParams["language-code"] = preferredLang;
  }

  // Partial-result stabilization (supported by Amazon Transcribe Streaming for
  // streaming transcriptions; enables stable vs. provisional words).
  if (settings.enablePartialResultsStabilization) {
    queryParams["enable-partial-results-stabilization"] = "true";
    const stability = isSttPartialStability(settings.partialResultsStability)
      ? settings.partialResultsStability
      : "medium";
    queryParams["partial-results-stability"] = stability;
  }

  const canonicalQueryString = buildCanonicalQueryString(queryParams);
  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = "host";

  const canonicalRequest = [
    "GET",
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    EMPTY_PAYLOAD_SHA256,
  ].join("\n");

  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmacSha256(`AWS4${creds.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, SERVICE);
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning)
    .update(stringToSign, "utf8")
    .digest("hex");

  const url = `wss://${host}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;

  return {
    url,
    region,
    sampleRate,
    languageCode: isSttLanguageCode(settings.languageCode)
      ? settings.languageCode
      : "en-US",
    identifyLanguage: useIdentifyLanguage,
    expiresIn,
  };
}
