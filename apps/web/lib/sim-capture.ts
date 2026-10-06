/**
 * Microphone capture for the simulator and Test Lab: the mic (plus optional
 * engine noise) through the sim-capture worklet, which resamples to 16 kHz and
 * posts 20 ms frames with their peak level.
 */
export interface Capture {
  stop: () => void;
}

export interface CaptureOptions {
  /** Off for the robot crew, so its voice reaches the mic like a headset mix. */
  echoCancellation: boolean;
  noise?: "moderate" | "heavy";
  onFrame: (pcm: Int16Array, db: number) => void;
}

export async function startCapture(opts: CaptureOptions): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: opts.echoCancellation, noiseSuppression: false, autoGainControl: true } });
  // The device's own rate: some browsers (Firefox) refuse to connect a mic to a context at
  // another rate. The worklet resamples to 16 kHz itself.
  const ctx = new AudioContext();
  try {
    await ctx.audioWorklet.addModule("/sim-worklet.js");
    const node = new AudioWorkletNode(ctx, "sim-capture");
    ctx.createMediaStreamSource(stream).connect(node);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute).connect(ctx.destination);
    if (opts.noise) {
      const res = await fetch(`/api/dev/noise?level=${opts.noise}`);
      const src = ctx.createBufferSource();
      src.buffer = await ctx.decodeAudioData(await res.arrayBuffer());
      src.loop = true;
      src.connect(node);
      src.start();
    }
    node.port.onmessage = (e: MessageEvent<{ pcm: Int16Array; db: number }>) => opts.onFrame(e.data.pcm, e.data.db);
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
    throw e;
  }
  return {
    stop: () => {
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}

/** Microphone setup failures in plain words. */
export function micProblem(e: unknown): string {
  const name = (e as Error).name;
  if (name === "NotAllowedError") return "Microphone access was blocked. Allow it in the browser's site settings, then try again.";
  if (name === "NotFoundError") return "No microphone was found. Connect one, then try again.";
  if (name === "NotReadableError") return "The microphone is in use by another app. Close it, then try again.";
  return `The microphone could not start (${(e as Error).message}). Try typing instead, or reload the page.`;
}
