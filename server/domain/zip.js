'use strict';

/**
 * A minimal zip writer (PKZIP 2.0: deflate, UTF-8 names, no zip64) for the project archive. Every
 * archive Codes builds is bounded well below zip's 4 GiB and 65,535-entry limits; past them it
 * throws rather than write a file other tools would misread.
 */
const zlib = require('zlib');

const MAX_BYTES = 0xffffffff;
const MAX_ENTRIES = 0xffff;

let table = null;
function crc32(buf) {
    if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
    if (!table) {
        table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            table[n] = c >>> 0;
        }
    }
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS time and date (UTC; zip has no time zone). */
function dosTime(d) {
    return {
        time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
        date: ((Math.max(1980, d.getUTCFullYear()) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    };
}

/**
 * entries: [{ name, data: Buffer | string }] in the order they are written. Returns one Buffer.
 * Small or incompressible entries are stored; the rest are deflated.
 */
function zip(entries, { date = new Date() } = {}) {
    if (entries.length > MAX_ENTRIES) throw new Error(`zip: ${entries.length} entries is past the zip limit`);
    const { time, date: day } = dosTime(date);
    const locals = [];
    const central = [];
    let offset = 0;
    for (const e of entries) {
        const name = Buffer.from(String(e.name), 'utf8');
        const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
        const deflated = data.length > 64 ? zlib.deflateRawSync(data, { level: 6 }) : null;
        const method = deflated && deflated.length < data.length ? 8 : 0;
        const body = method === 8 ? deflated : data;
        const crc = crc32(data);
        if (data.length > MAX_BYTES || offset + 30 + name.length + body.length > MAX_BYTES) throw new Error('zip: past the 4 GiB limit');
        const head = Buffer.alloc(30);
        head.writeUInt32LE(0x04034b50, 0);
        head.writeUInt16LE(20, 4);
        head.writeUInt16LE(0x0800, 6);           // names are UTF-8
        head.writeUInt16LE(method, 8);
        head.writeUInt16LE(time, 10);
        head.writeUInt16LE(day, 12);
        head.writeUInt32LE(crc, 14);
        head.writeUInt32LE(body.length, 18);
        head.writeUInt32LE(data.length, 22);
        head.writeUInt16LE(name.length, 26);
        head.writeUInt16LE(0, 28);
        locals.push(head, name, body);
        const dir = Buffer.alloc(46);
        dir.writeUInt32LE(0x02014b50, 0);
        dir.writeUInt16LE(20, 4);
        dir.writeUInt16LE(20, 6);
        dir.writeUInt16LE(0x0800, 8);
        dir.writeUInt16LE(method, 10);
        dir.writeUInt16LE(time, 12);
        dir.writeUInt16LE(day, 14);
        dir.writeUInt32LE(crc, 16);
        dir.writeUInt32LE(body.length, 20);
        dir.writeUInt32LE(data.length, 24);
        dir.writeUInt16LE(name.length, 28);
        dir.writeUInt32LE(offset, 42);
        central.push(dir, name);
        offset += head.length + name.length + body.length;
    }
    const dirBytes = central.reduce((n, b) => n + b.length, 0);
    if (offset + dirBytes + 22 > MAX_BYTES) throw new Error('zip: past the 4 GiB limit');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(dirBytes, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, ...central, end]);
}

module.exports = { zip, crc32 };
