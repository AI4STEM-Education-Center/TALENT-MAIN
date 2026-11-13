// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../../next.config.mjs";
import {
  describeMicrophoneError,
  startMicrophoneCapture,
  TARGET_CHUNK_SAMPLES,
  TARGET_SAMPLE_RATE,
} from "./audio-capture";

describe("next.config.mjs STT security headers", () => {
  it("allows same-origin microphone access globally, overrides simulation content back to microphone=(), and serves static AudioWorklet under script-src 'self'", async () => {
    const rules = await nextConfig.headers!();
    const globalIndex = rules.findIndex((r) => r.source === "/:path*");
    const simIndex = rules.findIndex(
      (r) => r.source === "/api/simulations/:id/content",
    );
    expect(globalIndex).toBeGreaterThanOrEqual(0);
    // Later matching rule wins in Next.js header resolution
    expect(simIndex).toBeGreaterThan(globalIndex);

    const globalPolicy = rules[globalIndex].headers.find(
      (h) => h.key === "Permissions-Policy",
    )?.value;
    expect(globalPolicy).toContain("microphone=(self)");
    expect(globalPolicy).not.toContain("microphone=()");
    expect(globalPolicy).toContain("camera=()");
    expect(globalPolicy).toContain("geolocation=()");

    const simPolicy = rules[simIndex].headers.find(
      (h) => h.key === "Permissions-Policy",
    )?.value;
    expect(simPolicy).toContain("microphone=()");
    expect(simPolicy).not.toContain("microphone=(self)");

    const cspReportOnly = rules[globalIndex].headers.find(
      (h) => h.key === "Content-Security-Policy-Report-Only",
    )?.value;
    expect(cspReportOnly).toContain("script-src 'self'");
    expect(cspReportOnly).toContain("wss://*.amazonaws.com:8443");

    const workletPath = path.join(
      process.cwd(),
      "public",
      "stt-pcm-capture-worklet.js",
    );
    expect(fs.existsSync(workletPath)).toBe(true);
    expect(fs.readFileSync(workletPath, "utf8")).toContain(
      'registerProcessor("stt-pcm-capture-processor"',
    );
  });
});

describe("describeMicrophoneError", () => {
  afterEach(() => {
    Reflect.deleteProperty(document, "permissionsPolicy");
    Reflect.deleteProperty(document, "featurePolicy");
  });

  it("distinguishes Permissions-Policy blocks, OS-level blocks, and browser site denials", () => {
    expect(
      describeMicrophoneError({
        name: "NotAllowedError",
        message: "Permission denied",
      }),
    ).toBe(
      "Microphone access was denied. Please allow microphone permission in your browser settings and try again.",
    );

    expect(
      describeMicrophoneError({
        name: "NotAllowedError",
        message: "Permission denied by system",
      }),
    ).toContain("operating system");

    expect(
      describeMicrophoneError({
        name: "NotAllowedError",
        message:
          "Permissions policy violation: microphone is not allowed in this document.",
      }),
    ).toContain("Permissions-Policy");

    Object.defineProperty(document, "permissionsPolicy", {
      configurable: true,
      value: {
        allowsFeature: (feature: string) => feature !== "microphone",
      },
    });
    expect(
      describeMicrophoneError({
        name: "NotAllowedError",
        message: "Permission denied",
      }),
    ).toContain("Permissions-Policy");

    Reflect.deleteProperty(document, "permissionsPolicy");
    Object.defineProperty(document, "featurePolicy", {
      configurable: true,
      value: {
        allowsFeature: (feature: string) => feature !== "microphone",
      },
    });
    expect(
      describeMicrophoneError({
        name: "NotAllowedError",
        message: "Permission denied",
      }),
    ).toContain("Permissions-Policy");
  });

  it("maps missing and busy hardware errors clearly", () => {
    expect(describeMicrophoneError({ name: "NotFoundError" })).toContain(
      "No microphone was found",
    );
    expect(describeMicrophoneError({ name: "NotReadableError" })).toContain(
      "currently in use",
    );
  });
});

describe("startMicrophoneCapture", () => {
  const originalMediaDevices = navigator.mediaDevices;
  const originalAudioContext = window.AudioContext;
  const originalAudioWorkletNode = globalThis.AudioWorkletNode;

  afterEach(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices,
    });
    window.AudioContext = originalAudioContext;
    globalThis.AudioWorkletNode = originalAudioWorkletNode;
  });

  it("loads same-origin AudioWorklet, falls back to native sample rate on cross-rate mismatch, connects to destination, and downsamples to 16 kHz chunks", async () => {
    const stopTrack = vi.fn();
    const fakeStream = {
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue(fakeStream),
      },
    });

    const connectSource = vi.fn();
    const disconnectSource = vi.fn();
    const connectWorklet = vi.fn();
    const disconnectWorklet = vi.fn();
    const closePort = vi.fn();
    const addModule = vi.fn().mockResolvedValue(undefined);
    const closeContexts: ReturnType<typeof vi.fn>[] = [];
    let latestWorkletPort: {
      onmessage: ((event: MessageEvent<Float32Array>) => void) | null;
      close: () => void;
    } | null = null;

    class MockAudioWorkletNode {
      port = {
        onmessage: null as ((event: MessageEvent<Float32Array>) => void) | null,
        close: closePort,
      };
      constructor() {
        latestWorkletPort = this.port;
      }
      connect = connectWorklet;
      disconnect = disconnectWorklet;
    }

    class MockAudioContext {
      state: AudioContextState = "running";
      sampleRate: number;
      destination = { kind: "destination" };
      audioWorklet = { addModule };
      close = vi.fn().mockImplementation(async () => {
        this.state = "closed";
      });

      constructor(opts?: AudioContextOptions) {
        this.sampleRate = opts?.sampleRate ?? 48_000;
        closeContexts.push(this.close);
      }

      resume = vi.fn().mockResolvedValue(undefined);

      createMediaStreamSource() {
        if (this.sampleRate === TARGET_SAMPLE_RATE) {
          throw new DOMException(
            "Connecting AudioNodes from AudioContexts with different sample-rate is currently not supported.",
            "NotSupportedError",
          );
        }
        return {
          connect: connectSource,
          disconnect: disconnectSource,
        } as unknown as MediaStreamAudioSourceNode;
      }
    }

    window.AudioContext = MockAudioContext as unknown as typeof AudioContext;
    globalThis.AudioWorkletNode =
      MockAudioWorkletNode as unknown as typeof AudioWorkletNode;

    const chunks: Int16Array[] = [];
    const handle = await startMicrophoneCapture((pcm) => {
      chunks.push(pcm);
    });

    expect(addModule).toHaveBeenCalledWith("/stt-pcm-capture-worklet.js");
    expect(closeContexts).toHaveLength(2);
    expect(closeContexts[0]).toHaveBeenCalledTimes(1);
    expect(connectSource).toHaveBeenCalledTimes(1);
    expect(connectWorklet).toHaveBeenCalledWith({ kind: "destination" });

    // 4,800 samples at 48 kHz = 1,600 samples at 16 kHz = 1 full 100ms chunk;
    // plus 300 extra 48 kHz samples = 100 residual 16 kHz samples flushed on stop().
    const input = new Float32Array(5_100).fill(0.5);
    latestWorkletPort!.onmessage!(new MessageEvent("message", { data: input }));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].length).toBe(TARGET_CHUNK_SAMPLES);

    handle.stop();
    expect(chunks).toHaveLength(2);
    expect(chunks[1].length).toBe(100);
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(disconnectWorklet).toHaveBeenCalledTimes(1);
    expect(closeContexts[1]).toHaveBeenCalledTimes(1);
  });
});
