'use strict';
/**
 * Reads a zip the way a general-purpose tool does: from the end-of-central-directory record, through
 * the central directory, to each local header; inflates and checks every entry's CRC-32 and sizes.
 * Returns a Map of name → Buffer, in central-directory order. Throws on anything malformed.
 */
const zlib = require('zlib');
const { crc32 } = require('../../server/domain/zip');

function unzip(buf) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('unzip: no end-of-central-directory record');
    const count = buf.readUInt16LE(eocd + 10);
    const dirSize = buf.readUInt32LE(eocd + 12);
    let p = buf.readUInt32LE(eocd + 16);
    if (p + dirSize !== eocd) throw new Error('unzip: central directory does not end at the end record');
    const out = new Map();
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`unzip: bad central header ${n}`);
        const flags = buf.readUInt16LE(p + 8);
        const method = buf.readUInt16LE(p + 10);
        const crc = buf.readUInt32LE(p + 16);
        const csize = buf.readUInt32LE(p + 20);
        const usize = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const local = buf.readUInt32LE(p + 42);
        const name = buf.slice(p + 46, p + 46 + nameLen).toString(flags & 0x0800 ? 'utf8' : 'latin1');
        p += 46 + nameLen + extraLen + commentLen;
        if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`unzip: bad local header for ${name}`);
        if (buf.slice(local + 30, local + 30 + buf.readUInt16LE(local + 26)).toString('utf8') !== name) throw new Error(`unzip: local name differs for ${name}`);
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const raw = buf.slice(start, start + csize);
        const data = method === 8 ? zlib.inflateRawSync(raw) : method === 0 ? raw : null;
        if (!data) throw new Error(`unzip: method ${method} for ${name}`);
        if (data.length !== usize) throw new Error(`unzip: size of ${name}`);
        if (crc32(data) !== crc) throw new Error(`unzip: CRC of ${name}`);
        if (out.has(name)) throw new Error(`unzip: ${name} twice`);
        out.set(name, data);
    }
    return out;
}

module.exports = { unzip };
