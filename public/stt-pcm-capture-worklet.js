// AudioWorklet processor for browser microphone capture (~100 ms Float32 chunks).
// Served from `'self'` (`/stt-pcm-capture-worklet.js`) so `audioWorklet.addModule`
// satisfies `script-src 'self'` without needing `blob:` in Content-Security-Policy.
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
