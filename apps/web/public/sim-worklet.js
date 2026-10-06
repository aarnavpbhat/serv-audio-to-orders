/**
 * Simulator capture: resamples the mic from the context's rate (44.1 or 48 kHz,
 * whatever the device uses) to 16 kHz by linear interpolation, collects 20 ms
 * frames (320 samples), converts them to 16-bit PCM and posts them with the
 * frame's peak level (dBFS) for the meter.
 */
const OUT_RATE = 16000;

class SimCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / OUT_RATE;
    this.pos = 0;
    this.prev = 0;
    this.buf = new Int16Array(320);
    this.n = 0;
    this.peak = 0;
  }

  push(v) {
    const x = Math.max(-1, Math.min(1, v));
    this.peak = Math.max(this.peak, Math.abs(x));
    this.buf[this.n++] = x < 0 ? x * 0x8000 : x * 0x7fff;
    if (this.n === this.buf.length) {
      const out = this.buf;
      this.port.postMessage({ pcm: out, db: this.peak > 0 ? 20 * Math.log10(this.peak) : -120 }, [out.buffer]);
      this.buf = new Int16Array(320);
      this.n = 0;
      this.peak = 0;
    }
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    // pos: where the next output sample falls, in input samples, relative to this block
    // (-1 is the last sample of the previous block).
    while (this.pos < ch.length - 1) {
      const i = Math.floor(this.pos);
      const f = this.pos - i;
      const a = i < 0 ? this.prev : ch[i];
      const b = ch[i + 1];
      this.push(a + (b - a) * f);
      this.pos += this.step;
    }
    this.prev = ch[ch.length - 1];
    this.pos -= ch.length;
    return true;
  }
}

registerProcessor("sim-capture", SimCapture);
