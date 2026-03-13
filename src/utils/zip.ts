/**
 * Simple ZIP Streamer for Bun
 * 
 * Generates a standard ZIP file (STORE method) as a ReadableStream.
 * Supports pre-calculating the total size for Content-Length headers.
 */

import type { ZipEntry } from "../types/zip";

export type { ZipEntry };

/**
 * Convert a JS Date to MS-DOS date/time packed into a single 32-bit value.
 * Layout: [YYYYYYYM MMMDDDDD] [HHHHHMMM MMMSSSSS]
 *   Year offset from 1980, Seconds / 2
 */
function toDosDateTime(date: Date): number {
  const s = Math.floor(date.getSeconds() / 2);
  const min = date.getMinutes();
  const h = date.getHours();
  const d = date.getDate();
  const m = date.getMonth() + 1;
  const y = date.getFullYear() - 1980;
  const dosTime = (h << 11) | (min << 5) | s;
  const dosDate = (y << 9) | (m << 5) | d;
  // Pack as little-endian: time (16-bit) then date (16-bit) = 32-bit
  return (dosDate << 16) | dosTime;
}

export class ZipStreamer {
  private static SIG_LOCAL = 0x04034b50;
  private static SIG_CENTRAL = 0x02014b50;
  private static SIG_EOCD = 0x06054b50;

  /**
   * Calculate the total size of the ZIP file before generation.
   */
  static calculateTotalSize(entries: ZipEntry[]): number {
    let size = 0;
    for (const entry of entries) {
      const nameBuf = Buffer.from(entry.name, "utf-8");
      // Local header (30) + Name + Data + Data Descriptor (12)
      size += 30 + nameBuf.length + entry.size + 12;
    }
    for (const entry of entries) {
      const nameBuf = Buffer.from(entry.name, "utf-8");
      // Central directory header (46) + Name
      size += 46 + nameBuf.length;
    }
    // End of central directory (22)
    size += 22;
    return size;
  }

  /**
   * Create a ReadableStream that yields the ZIP file content.
   */
  static createStream(entries: ZipEntry[]): ReadableStream {
    const entryData: { crc: number; offset: number }[] = [];
    const now = new Date();
    const dosDateTime = toDosDateTime(now);
    
    return new ReadableStream({
      async start(controller) {
        let currentOffset = 0;

        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const nameBuf = Buffer.from(entry.name, "utf-8");
          const offset = currentOffset;

          // 1. Local File Header
          const header = Buffer.alloc(30);
          header.writeUInt32LE(ZipStreamer.SIG_LOCAL, 0);
          header.writeUInt16LE(20, 4); // Version needed (2.0)
          header.writeUInt16LE(0x0808, 6); // Flags: Bit 3 (data descriptor) + Bit 11 (UTF-8)
          header.writeUInt16LE(0, 8); // Method: Store
          header.writeUInt32LE(dosDateTime, 10); // MS-DOS Date/Time
          header.writeUInt32LE(0, 14); // CRC (0 because of bit 3)
          header.writeUInt32LE(0, 18); // Compressed size (0 because of bit 3)
          header.writeUInt32LE(0, 22); // Uncompressed size (0 because of bit 3)
          header.writeUInt16LE(nameBuf.length, 26);
          header.writeUInt16LE(0, 28); // Extra field len

          controller.enqueue(header);
          controller.enqueue(nameBuf);
          currentOffset += 30 + nameBuf.length;

          // 2. File Data
          const file = Bun.file(entry.path);
          const reader = file.stream().getReader();
          let crc = 0;
          
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            crc = Bun.hash.crc32(value, crc);
            controller.enqueue(value);
            currentOffset += value.length;
          }

          // 3. Data Descriptor (12 bytes)
          const desc = Buffer.alloc(12);
          desc.writeUInt32LE(crc, 0);
          desc.writeUInt32LE(entry.size, 4);
          desc.writeUInt32LE(entry.size, 8);
          controller.enqueue(desc);
          currentOffset += 12;

          entryData.push({ crc, offset });
        }

        // 4. Central Directory
        const cdStart = currentOffset;
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const meta = entryData[i];
          const nameBuf = Buffer.from(entry.name, "utf-8");

          const cd = Buffer.alloc(46);
          cd.writeUInt32LE(ZipStreamer.SIG_CENTRAL, 0);
          cd.writeUInt16LE(20, 4); // Made by
          cd.writeUInt16LE(20, 6); // Needed
          cd.writeUInt16LE(0x0808, 8); // Flags
          cd.writeUInt16LE(0, 10); // Method
          cd.writeUInt32LE(dosDateTime, 12); // MS-DOS Date/Time
          cd.writeUInt32LE(meta.crc, 16);
          cd.writeUInt32LE(entry.size, 20);
          cd.writeUInt32LE(entry.size, 24);
          cd.writeUInt16LE(nameBuf.length, 28);
          cd.writeUInt16LE(0, 30); // Extra len
          cd.writeUInt16LE(0, 32); // Comment len
          cd.writeUInt16LE(0, 34); // Disk start
          cd.writeUInt16LE(0, 36); // Internal attr
          cd.writeUInt32LE(0, 38); // External attr
          cd.writeUInt32LE(meta.offset, 42);

          controller.enqueue(cd);
          controller.enqueue(nameBuf);
          currentOffset += 46 + nameBuf.length;
        }

        const cdSize = currentOffset - cdStart;

        // 5. End of Central Directory
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(ZipStreamer.SIG_EOCD, 0);
        eocd.writeUInt16LE(0, 4); // Disk num
        eocd.writeUInt16LE(0, 6); // CD disk
        eocd.writeUInt16LE(entries.length, 8); // Disk entries
        eocd.writeUInt16LE(entries.length, 10); // Total entries
        eocd.writeUInt32LE(cdSize, 12);
        eocd.writeUInt32LE(cdStart, 16);
        eocd.writeUInt16LE(0, 20); // Comment len

        controller.enqueue(eocd);
        controller.close();
      },
    });
  }
}
