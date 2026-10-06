/**
 * BlobStore: where every artifact's bytes live. LocalBlobStore keeps them under
 * DATA_DIR/blobs with the same key layout object storage would use, so moving
 * to S3 later is a new implementation, not a new layout.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface PutResult {
  uri: string;
  sha256: string;
  bytes: number;
}

export interface BlobMeta {
  contentType?: string;
}

export interface BlobStore {
  put(key: string, data: Uint8Array | string | Iterable<Uint8Array> | AsyncIterable<Uint8Array>, meta?: BlobMeta): Promise<PutResult>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

/** Keys are slash-separated segments of letters, digits, "=", ".", "_" and "-"; no "..", no leading slash. */
const SEGMENT = /^[A-Za-z0-9=._-]{1,128}$/;

export function assertKey(key: string): string[] {
  const parts = key.split("/");
  if (!parts.length || parts.some((p) => !SEGMENT.test(p) || p === "." || p === "..")) throw new Error(`Invalid blob key "${key.slice(0, 200)}"`);
  return parts;
}

async function collect(data: Uint8Array | string | Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<Buffer> {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const chunks: Buffer[] = [];
  for await (const c of data as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

export class LocalBlobStore implements BlobStore {
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  private file(key: string): string {
    return path.join(this.root, ...assertKey(key));
  }

  async put(key: string, data: Uint8Array | string | Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<PutResult> {
    const file = this.file(key);
    const buf = await collect(data);
    mkdirSync(path.dirname(file), { recursive: true });
    // Write then rename, so a crash never leaves a half-written blob under its real key.
    const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, buf);
    renameSync(tmp, file);
    return { uri: key, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(readFileSync(this.file(key)));
  }

  async exists(key: string): Promise<boolean> {
    return existsSync(this.file(key));
  }

  async delete(key: string): Promise<void> {
    rmSync(this.file(key), { force: true });
  }

  async list(prefix: string): Promise<string[]> {
    const parts = prefix ? assertKey(prefix.replace(/\/$/, "")) : [];
    const start = path.join(this.root, ...parts);
    if (!existsSync(start)) return [];
    const out: string[] = [];
    const walk = (dir: string, rel: string[]) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(dir, e.name), [...rel, e.name]);
        else if (!e.name.includes(".tmp-")) out.push([...rel, e.name].join("/"));
      }
    };
    if (statSync(start).isDirectory()) walk(start, parts);
    else out.push(parts.join("/"));
    return out.sort();
  }
}

/** Placeholder for object storage (same key layout). Not implemented in the sandbox. */
export class S3BlobStore implements BlobStore {
  constructor(readonly bucket: string) {}
  private nope(): never {
    throw new Error("S3BlobStore is not implemented (sandbox keeps blobs on local disk)");
  }
  async put(): Promise<PutResult> {
    return this.nope();
  }
  async get(): Promise<Uint8Array> {
    return this.nope();
  }
  async exists(): Promise<boolean> {
    return this.nope();
  }
  async delete(): Promise<void> {
    return this.nope();
  }
  async list(): Promise<string[]> {
    return this.nope();
  }
}
