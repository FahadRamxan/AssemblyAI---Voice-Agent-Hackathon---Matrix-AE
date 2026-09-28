/**
 * AudioWorklet mic capture — runs on the audio-render thread (no main-thread
 * GC jank). Downsamples the browser's native rate (usually 44.1/48 kHz) to
 * 16 kHz mono, converts Float32 -> Int16 little-endian, and posts ~50 ms
 * frames (800 samples = 1600 bytes) back to the page to stream to AssemblyAI.
 *
 * Why software downsampling: `new AudioContext({ sampleRate: 16000 })` is not
 * honoured by Safari/Firefox, so we always run at the native rate and resample
 * here, tracking a fractional read position across 128-sample blocks so there
 * are no clicks at block boundaries.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.ratio = sampleRate / this.targetRate; // `sampleRate` is the worklet global (native rate)
    this.pos = 0; // fractional read position into `carry`
    this.carry = new Float32Array(0); // input samples not yet consumed
    this.frame = []; // Int16 accumulator
    this.frameSamples = 800; // 50 ms @ 16 kHz
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;

    // Prepend last call's leftover so interpolation is continuous.
    const input = new Float32Array(this.carry.length + ch.length);
    input.set(this.carry, 0);
    input.set(ch, this.carry.length);

    let pos = this.pos;
    while (Math.floor(pos) + 1 < input.length) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const s = input[i] * (1 - frac) + input[i + 1] * frac; // linear interpolation
      let v = s < 0 ? s * 0x8000 : s * 0x7fff; // Float32 [-1,1] -> Int16
      if (v > 32767) v = 32767;
      else if (v < -32768) v = -32768;
      this.frame.push(v);
      if (this.frame.length >= this.frameSamples) {
        const buf = new Int16Array(this.frame).buffer;
        this.port.postMessage(buf, [buf]); // transfer, no copy
        this.frame = [];
      }
      pos += this.ratio;
    }

    const consumed = Math.floor(pos);
    this.carry = input.slice(consumed); // keep the tail for next block
    this.pos = pos - consumed;
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
