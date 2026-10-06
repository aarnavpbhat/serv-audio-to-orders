/**
 * Raw capture: every incoming message (binary and text) is written, with its
 * receive time, before it is decoded, so real HME traffic can be inspected and
 * replayed byte for byte once it arrives.
 *
 * A part is written as it fills (part-NNNNN.bin.open plus its index), then
 * rolled every 60 s or 5 MB: compressed with zstd (lossless) to
 * part-NNNNN.bin.zst with part-NNNNN.index.ndjson
 * ({seq, received_at, kind, offset, length} per message). A part left open by
 * a crash is finished as part-NNNNN.incomplete.bin.zst on the next start.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { assertSafeId } from "../lib/safe-id";

export interface RawIndexLine {
  seq: number;
  received_at: string;
  kind: "binary" | "text";
  offset: number;
  length: number;
}

export interface RollInfo {
  dir: string;
  part: number;
  file: string;
  index: string;
  bytes: number;
  messages: number;
  incomplete: boolean;
}

export interface RawWriterOptions {
  rollMs?: number;
  rollBytes?: number;
  now?: () => number;
  /** Called after each part is finished (the data store records it in its catalog). */
  onRoll?: (info: RollInfo) => void;
}

const pad = (n: number) => String(n).padStart(5, "0");

export class RawWriter {
  private part = 0;
  private openedAt = 0;
  private offset = 0;
  private seq = 0;
  private messages = 0;
  private closed = false;
  private readonly now: () => number;

  constructor(
    readonly dir: string,
    private readonly opts: RawWriterOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    mkdirSync(dir, { recursive: true });
    this.part = Math.max(0, ...readdirSync(dir).map((f) => Number(/^part-(\d+)/.exec(f)?.[1] ?? 0)));
  }

  /** Directory for one session's capture; every id is checked before it becomes a path. */
  static sessionDir(root: string, storeId: string, laneId: string, sessionId: string): string {
    return path.join(root, assertSafeId("store", storeId), assertSafeId("lane", laneId), assertSafeId("session", sessionId));
  }

  private paths(part: number) {
    const base = path.join(this.dir, `part-${pad(part)}`);
    return { open: `${base}.bin.open`, openIndex: `${base}.index.open`, zst: `${base}.bin.zst`, index: `${base}.index.ndjson` };
  }

  write(kind: "binary" | "text", bytes: Uint8Array, receivedAt: number): void {
    if (this.closed) return;
    const t = this.now();
    if (!this.part || !existsSync(this.paths(this.part).open)) this.start(t);
    else if (t - this.openedAt >= (this.opts.rollMs ?? 60_000) || this.offset >= (this.opts.rollBytes ?? 5 * 1024 * 1024)) {
      this.roll(false);
      this.start(t);
    }
    const p = this.paths(this.part);
    appendFileSync(p.open, bytes);
    const line: RawIndexLine = { seq: this.seq++, received_at: new Date(receivedAt).toISOString(), kind, offset: this.offset, length: bytes.length };
    appendFileSync(p.openIndex, JSON.stringify(line) + "\n");
    this.offset += bytes.length;
    this.messages++;
  }

  private start(t: number): void {
    this.part++;
    this.openedAt = t;
    this.offset = 0;
    this.messages = 0;
    const p = this.paths(this.part);
    writeFileSync(p.open, new Uint8Array(0));
    writeFileSync(p.openIndex, "");
  }

  private roll(incomplete: boolean): void {
    if (!this.part) return;
    const info = finishPart(this.dir, this.part, incomplete);
    if (info) this.opts.onRoll?.(info);
  }

  /** Flush the open part (on session close). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.part && existsSync(this.paths(this.part).open)) this.roll(false);
  }
}

/** Compress an open part and its index; incomplete marks a part left open by a crash. */
function finishPart(dir: string, part: number, incomplete: boolean): RollInfo | null {
  const base = path.join(dir, `part-${pad(part)}`);
  const open = `${base}.bin.open`;
  const openIndex = `${base}.index.open`;
  if (!existsSync(open)) return null;
  const raw = readFileSync(open);
  const name = incomplete ? `part-${pad(part)}.incomplete` : `part-${pad(part)}`;
  const file = path.join(dir, `${name}.bin.zst`);
  const index = path.join(dir, `${name}.index.ndjson`);
  writeFileSync(file, zstdCompressSync(raw));
  if (existsSync(openIndex)) renameSync(openIndex, index);
  else writeFileSync(index, "");
  rmSync(open);
  const messages = readFileSync(index, "utf8").split("\n").filter(Boolean).length;
  return { dir, part, file, index, bytes: raw.length, messages, incomplete };
}

/** On start: finish every part a crash left open, marked incomplete. */
export function recoverOpenParts(root: string, onRoll?: (info: RollInfo) => void): number {
  if (!existsSync(root)) return 0;
  let n = 0;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".bin.open")) {
        const part = Number(/^part-(\d+)/.exec(e.name)?.[1] ?? 0);
        const info = finishPart(dir, part, true);
        if (info) {
          n++;
          onRoll?.(info);
        }
      }
    }
  };
  walk(root);
  return n;
}

/** Read a finished part back: every message, byte for byte, in order. */
export function readPart(file: string, index: string): { line: RawIndexLine; bytes: Uint8Array }[] {
  return decodePart(readFileSync(file), readFileSync(index, "utf8"));
}

/** A finished part's bytes (zstd) and index text -> its messages, in order. */
export function decodePart(zst: Uint8Array, index: string): { line: RawIndexLine; bytes: Uint8Array }[] {
  const data = zstdDecompressSync(zst);
  return index
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RawIndexLine)
    .map((line) => ({ line, bytes: new Uint8Array(data.subarray(line.offset, line.offset + line.length)) }));
}
