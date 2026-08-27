/**
 * Minimal ZIP writer (deflate), so `make-release.mjs` works on any machine
 * without needing the `zip` command installed.
 */

import { deflateRawSync, crc32 } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { walk } from "./fsx.mjs";

// node:zlib exposes crc32 from Node 20.12+/22. Fall back to a table version.
let crc32of = crc32;
if (typeof crc32of !== "function") {
  const TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    TABLE[n] = c;
  }
  crc32of = (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
}

function dosDateTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/**
 * @param entries [{ name, data (Buffer), mode }]
 * @returns Buffer of a complete zip archive
 */
export function makeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const { time, date } = dosDateTime(now);

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const crc = crc32of(e.data) >>> 0;
    const deflated = deflateRawSync(e.data, { level: 6 });
    // If compression made it bigger (already-compressed assets), store it raw.
    const useStore = deflated.length >= e.data.length;
    const body = useStore ? e.data : deflated;
    const method = useStore ? 0 : 8;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x0800, 6); // utf-8 names
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x031e, 4); // made by unix
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); // extra
    ch.writeUInt16LE(0, 32); // comment
    ch.writeUInt16LE(0, 34); // disk
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE(((e.mode || 0o644) & 0xfff) << 16, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...local, centralBuf, eocd]);
}

/** Zip a directory, skipping anything the matcher rejects. */
export function zipDirectory(dir, { skip = () => false } = {}) {
  const files = walk(dir, { skip });
  const entries = files.map((rel) => {
    const abs = path.join(dir, rel);
    let mode = 0o644;
    try {
      mode = fs.statSync(abs).mode & 0xfff;
    } catch {
      /* default */
    }
    return { name: rel, data: fs.readFileSync(abs), mode };
  });
  return { buffer: makeZip(entries), files };
}
