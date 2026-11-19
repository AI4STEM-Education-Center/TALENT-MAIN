// Browser microphone capture, resampling to 16 kHz mono, and 16-bit signed
// little-endian PCM chunking (~100 ms per chunk = 1,600 samples = 3,200 bytes).
//
// Uses AudioWorkletNode (via an inline Blob module so no static public file is
// required) with a graceful fallback to ScriptProcessorNode if AudioWorklet is
// unavailable.

export const TARGET_SAMPLE_RATE = 16_000;
/** 100 ms of 16 kHz mono audio = 1,600 samples = 3,200 bytes. */
export const TARGET_CHUNK_SAMPLES = 1_600;

/**
 * Pure resampler & Float32 [-1, 1] -> signed 16-bit PCM converter.
 * Exported so unit tests can verify 48 kHz / 44.1 kHz -> 16 kHz downsampling
 * and clamping without needing a live browser AudioContext.
 */
export function downsampleAndConvertToPcm16(
  input: Float32Array,
  inputSampleRate: number,
  targetSampleRate = TARGET_SAMPLE_RATE,
): Int16Array {
  if (input.length === 0) return new Int16Array(0);

  if (inputSampleRate === targetSampleRate) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    }
    return out;
  }

  const ratio = inputSampleRate / targetSampleRate;
  const outputLength = Math.floor(input.length / ratio);
  const out = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += input[j];
      count += 1;
    }
    const sample =
      count > 0 ? sum / count : input[Math.min(start, input.length - 1)];
    const clamped = Math.max(-1, Math.min(1, sample));
    out[i] =
      clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
  }

  return out;
}

const WORKLET_PROCESSOR_SOURCE = `
class SttPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      const channel = input[0];
      for (let i = 0; i < channel.length; i++) {
        this._buffer.push(channel[i]);
      }
      // Emit roughly every ~100ms of input samples
      const threshold = Math.max(1024, Math.round(sampleRate * 0.1));
      if (this._buffer.length >= threshold) {
        const chunk = new Float32Array(this._buffer);
        this._buffer = [];
        this.port.postMessage(chunk, [chunk.buffer]);
      }
    }
    return true;
  }
}
registerProcessor("stt-pcm-capture-processor", SttPcmCaptureProcessor);
`;

export interface AudioCaptureHandle {
  /**
   * Immediately stop microphone tracks, flush any buffered PCM samples through
   * `onPcmChunk`, and close the AudioContext. Idempotent.
   */
  stop: () => void;
}

function isMicrophoneBlockedByPermissionsPolicy(): boolean {
  if (typeof document === "undefined") return false;
  const doc = document as Document & {
    permissionsPolicy?: { allowsFeature?: (feature: string) => boolean };
    featurePolicy?: { allowsFeature?: (feature: string) => boolean };
  };
  const policy = doc.permissionsPolicy ?? doc.featurePolicy;
  if (typeof policy?.allowsFeature === "function") {
    try {
      return policy.allowsFeature("microphone") === false;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Translate browser `getUserMedia` errors into clear, actionable messages.
 */
export function describeMicrophoneError(error: unknown): string {
  const errObj = error as { name?: string; message?: string } | null;
  const name = errObj?.name ?? "";
  const message = errObj?.message ?? "";
  if (
    name === "NotAllowedError" ||
    name === "PermissionDeniedError" ||
    name === "SecurityError"
  ) {
    if (
      isMicrophoneBlockedByPermissionsPolicy() ||
      /permissions? policy|feature policy|not allowed in this document/i.test(
        message,
      )
    ) {
      return "Microphone access is blocked by this page's Permissions-Policy header or frame settings.";
    }
    if (/by system/i.test(message)) {
      return "Microphone access was blocked by your operating system. Allow microphone access for your browser in your system privacy settings and try again.";
    }
    return "Microphone access was denied. Please allow microphone permission in your browser settings and try again.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No microphone was found. Please connect a microphone and try again.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "Your microphone is currently in use by another application.";
  }
  return "Could not access the microphone. Please check your audio settings and try again.";
}

/**
 * Start capturing mono microphone audio and streaming ~100ms 16 kHz 16-bit PCM
 * chunks to `onPcmChunk`.
 */
export async function startMicrophoneCapture(
  onPcmChunk: (pcm16: Int16Array) => void,
): Promise<AudioCaptureHandle> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== "function"
  ) {
    throw new Error(
      "Voice input is not supported in this browser or requires a secure (HTTPS) connection.",
    );
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: TARGET_SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    throw new Error(describeMicrophoneError(err));
  }

  let stopped = false;
  let audioContext: AudioContext | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let scriptNode: ScriptProcessorNode | null = null;
  let workletUrl: string | null = null;

  // Accumulate 16 kHz Int16 samples so every emitted frame is a consistent
  // ~100ms (1,600 samples) chunk.
  let pendingSamples = new Int16Array(0);

  const pushFloatSamples = (floatSamples: Float32Array, inputRate: number) => {
    if (stopped) return;
    const pcm = downsampleAndConvertToPcm16(
      floatSamples,
      inputRate,
      TARGET_SAMPLE_RATE,
    );
    if (pcm.length === 0) return;

    const merged = new Int16Array(pendingSamples.length + pcm.length);
    merged.set(pendingSamples, 0);
    merged.set(pcm, pendingSamples.length);

    let offset = 0;
    while (merged.length - offset >= TARGET_CHUNK_SAMPLES) {
      const slice = merged.slice(offset, offset + TARGET_CHUNK_SAMPLES);
      onPcmChunk(slice);
      offset += TARGET_CHUNK_SAMPLES;
    }
    pendingSamples = merged.slice(offset);
  };

  const cleanup = () => {
    if (stopped) return;
    stopped = true;

    // Flush any remaining sub-chunk of audio before tearing down
    if (pendingSamples.length > 0) {
      const remaining = pendingSamples;
      pendingSamples = new Int16Array(0);
      try {
        onPcmChunk(remaining);
      } catch {
        // Ignore callback errors during teardown
      }
    }

    try {
      workletNode?.port.close();
      workletNode?.disconnect();
    } catch {
      // Ignore
    }
    try {
      scriptNode?.disconnect();
    } catch {
      // Ignore
    }
    try {
      sourceNode?.disconnect();
    } catch {
      // Ignore
    }
    if (workletUrl && typeof URL.revokeObjectURL === "function") {
      try {
        URL.revokeObjectURL(workletUrl);
      } catch {
        // Ignore
      }
    }
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // Ignore
      }
    }
    if (audioContext && audioContext.state !== "closed") {
      void audioContext.close().catch(() => {});
    }
  };

  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) {
      throw new Error("Web Audio API is not supported in this browser.");
    }

    // Prefer a 16 kHz AudioContext, but fall back to the device's native sample
    // rate if the browser (e.g. Firefox) rejects connecting a 48 kHz MediaStream
    // to a 16 kHz AudioContext — `downsampleAndConvertToPcm16` resamples cleanly.
    try {
      audioContext = new AudioCtx({ sampleRate: TARGET_SAMPLE_RATE });
      sourceNode = audioContext.createMediaStreamSource(stream);
    } catch {
      if (audioContext && audioContext.state !== "closed") {
        void audioContext.close().catch(() => {});
      }
      audioContext = new AudioCtx();
      sourceNode = audioContext.createMediaStreamSource(stream);
    }
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    const actualSampleRate = audioContext.sampleRate || TARGET_SAMPLE_RATE;

    let useWorklet = false;
    if (audioContext.audioWorklet && typeof AudioWorkletNode !== "undefined") {
      try {
        try {
          await audioContext.audioWorklet.addModule(
            "/stt-pcm-capture-worklet.js",
          );
        } catch (staticErr) {
          if (
            typeof Blob === "undefined" ||
            typeof URL.createObjectURL !== "function"
          ) {
            throw staticErr;
          }
          const blob = new Blob([WORKLET_PROCESSOR_SOURCE], {
            type: "application/javascript",
          });
          workletUrl = URL.createObjectURL(blob);
          await audioContext.audioWorklet.addModule(workletUrl);
        }
        workletNode = new AudioWorkletNode(
          audioContext,
          "stt-pcm-capture-processor",
        );
        workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
          if (event.data instanceof Float32Array) {
            pushFloatSamples(event.data, actualSampleRate);
          }
        };
        sourceNode.connect(workletNode);
        // Connect to destination so pull-based audio graphs (Safari/WebKit)
        // invoke `process()`. The processor leaves outputs untouched (silent 0s).
        workletNode.connect(audioContext.destination);
        useWorklet = true;
      } catch {
        // Fall back to ScriptProcessorNode if AudioWorklet cannot load
        useWorklet = false;
      }
    }

    if (!useWorklet) {
      const bufferSize = 4096;
      scriptNode = audioContext.createScriptProcessor(bufferSize, 1, 1);
      scriptNode.onaudioprocess = (event: AudioProcessingEvent) => {
        if (stopped) return;
        const channelData = event.inputBuffer.getChannelData(0);
        pushFloatSamples(new Float32Array(channelData), actualSampleRate);
      };
      sourceNode.connect(scriptNode);
      scriptNode.connect(audioContext.destination);
    }

    return { stop: cleanup };
  } catch (err) {
    cleanup();
    throw err instanceof Error
      ? err
      : new Error("Failed to initialize microphone audio processing.");
  }
}
