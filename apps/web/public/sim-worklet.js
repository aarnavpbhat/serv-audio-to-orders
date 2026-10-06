/**
 * Simulator capture: runs in an AudioContext created at 16 kHz, so the browser
 * resamples the mic. Collects 20 ms frames (320 samples), converts them to
 * 16-bit PCM and posts them with the frame's peak level (dBFS) for the meter.
 */
class SimCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(320);
    this.n = 0;
    this.peak = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const v = Math.max(-1, Math.min(1, ch[i]));
      this.peak = Math.max(this.peak, Math.abs(v));
      this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.n === this.buf.length) {
        const out = this.buf;
        this.port.postMessage({ pcm: out, db: this.peak > 0 ? 20 * Math.log10(this.peak) : -120 }, [out.buffer]);
        this.buf = new Int16Array(320);
        this.n = 0;
        this.peak = 0;
      }
    }
    return true;
  }
}

registerProcessor("sim-capture", SimCapture);
