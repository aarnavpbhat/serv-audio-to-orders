/**
 * Clock offset against an NTP server (SNTP, one UDP request). With receive_clock
 * timestamps, order times are only as good as this machine's clock, so the
 * server logs the offset at startup.
 */
import { createSocket } from "node:dgram";

const NTP_EPOCH_OFFSET_S = 2_208_988_800;

/** Offset in ms (server time minus local time), or null when no answer arrives in time. */
export function ntpOffsetMs(host = "time.google.com", timeoutMs = 2000): Promise<number | null> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    const packet = Buffer.alloc(48);
    packet[0] = 0x1b; // LI 0, version 3, client mode
    const t1 = Date.now();
    const timer = setTimeout(() => {
      socket.close();
      resolve(null);
    }, timeoutMs);
    socket.on("error", () => {
      clearTimeout(timer);
      socket.close();
      resolve(null);
    });
    socket.on("message", (msg) => {
      clearTimeout(timer);
      const t4 = Date.now();
      socket.close();
      if (msg.length < 48) return resolve(null);
      const ts = (off: number) => (msg.readUInt32BE(off) - NTP_EPOCH_OFFSET_S) * 1000 + (msg.readUInt32BE(off + 4) * 1000) / 2 ** 32;
      const t2 = ts(32);
      const t3 = ts(40);
      resolve(Math.round((t2 - t1 + (t3 - t4)) / 2));
    });
    socket.send(packet, 123, host);
  });
}
