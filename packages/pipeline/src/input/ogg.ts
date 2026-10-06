/** Minimal Ogg page reader: splits an Ogg Opus stream into raw Opus packets (for the replay encoder and tests). */

export interface OggPacket {
  data: Uint8Array;
  granule: bigint;
}

export function oggPackets(bytes: Uint8Array): OggPacket[] {
  const out: OggPacket[] = [];
  let pending: Uint8Array[] = [];
  let pos = 0;
  while (pos + 27 <= bytes.length) {
    if (String.fromCharCode(...bytes.subarray(pos, pos + 4)) !== "OggS") throw new Error(`Ogg: lost sync at byte ${pos}`);
    const view = new DataView(bytes.buffer, bytes.byteOffset + pos);
    const granule = view.getBigInt64(6, true);
    const segments = bytes[pos + 26] ?? 0;
    const table = bytes.subarray(pos + 27, pos + 27 + segments);
    let data = pos + 27 + segments;
    let size = 0;
    for (let i = 0; i < segments; i++) {
      const lace = table[i] ?? 0;
      size += lace;
      if (lace < 255) {
        pending.push(bytes.subarray(data, data + size));
        const total = pending.reduce((n, p) => n + p.length, 0);
        const packet = new Uint8Array(total);
        let o = 0;
        for (const p of pending) {
          packet.set(p, o);
          o += p.length;
        }
        out.push({ data: packet, granule });
        pending = [];
        data += size;
        size = 0;
      }
    }
    if (size) {
      pending.push(bytes.subarray(data, data + size));
      data += size;
    }
    pos = data;
  }
  return out;
}

/** Opus audio packets only (drops the OpusHead and OpusTags header packets). */
export function opusAudioPackets(oggBytes: Uint8Array): Uint8Array[] {
  const ascii = (p: Uint8Array) => String.fromCharCode(...p.subarray(0, 8));
  return oggPackets(oggBytes)
    .map((p) => p.data)
    .filter((p) => ascii(p) !== "OpusHead" && ascii(p) !== "OpusTags");
}
