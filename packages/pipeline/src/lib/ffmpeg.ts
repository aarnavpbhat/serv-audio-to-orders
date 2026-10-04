/// <reference path="../types/ffprobe-static.d.ts" />
import { spawn } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

export const FFMPEG = process.env.FFMPEG_PATH ?? ffmpegStatic ?? "ffmpeg";
export const FFPROBE = process.env.FFPROBE_PATH ?? ffprobeStatic.path ?? "ffprobe";

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

/** Runs a binary, resolves with stdout as a Buffer. Rejects on non-zero exit with stderr in the message. */
export function run(bin: string, args: string[], input?: Buffer): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      const stderr = Buffer.concat(err).toString("utf8");
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr });
      else reject(new Error(`${bin.split("/").pop()} exited ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

export const ffmpeg = (args: string[], input?: Buffer) => run(FFMPEG, ["-hide_banner", "-loglevel", "error", ...args], input);
export const ffprobe = (args: string[]) => run(FFPROBE, ["-v", "error", ...args]);

/** Decodes any audio file to mono (or one channel) float32 PCM at the given rate. */
export async function decodePcm(file: string, sampleRate: number, channel?: number): Promise<Float32Array> {
  const pan = channel === undefined ? ["-ac", "1"] : ["-af", `pan=mono|c0=c${channel}`];
  const { stdout } = await ffmpeg(["-i", file, ...pan, "-ar", String(sampleRate), "-f", "f32le", "pipe:1"]);
  return new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength));
}

/** Encodes interleaved float32 PCM to an audio file (format from the extension). */
export async function encodePcm(
  pcm: Float32Array,
  opts: { sampleRate: number; channels: number; out: string; outRate?: number; bitrate?: string; filter?: string },
): Promise<void> {
  const args = ["-y", "-f", "f32le", "-ar", String(opts.sampleRate), "-ac", String(opts.channels), "-i", "pipe:0"];
  if (opts.filter) args.push("-af", opts.filter);
  if (opts.outRate) args.push("-ar", String(opts.outRate));
  if (opts.bitrate) args.push("-b:a", opts.bitrate);
  args.push(opts.out);
  await ffmpeg(args, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
}
