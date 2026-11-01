'use strict';
/**
 * Sealing a secret Codes must keep (a person's OpenVibe Git tokens): AES-256-GCM under CODES_SEAL_KEY, a fresh 12-byte
 * nonce each time, and the subject as associated data, so a sealed value moved to another person's row does not open.
 *
 *   const seal = createSeal(base64Key)      // null when the key is missing or not 32 bytes: the feature stays off
 *   seal.close(plain, subject) → 'v1.<nonce>.<tag>.<cipher>' (base64url)
 *   seal.open(sealed, subject) → plain, or null when it was not sealed with this key for this subject
 *
 * Nothing here logs, and a value that does not open is null, never an exception with the value in it.
 */
const crypto = require('crypto');

function createSeal(base64Key) {
    let key;
    try { key = Buffer.from(String(base64Key || ''), 'base64'); } catch { return null; }
    if (key.length !== 32) return null;
    const b64 = (b) => b.toString('base64url');
    return {
        close(plain, subject) {
            const nonce = crypto.randomBytes(12);
            const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
            c.setAAD(Buffer.from(String(subject || ''), 'utf8'));
            const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
            return `v1.${b64(nonce)}.${b64(c.getAuthTag())}.${b64(body)}`;
        },
        open(sealed, subject) {
            const parts = String(sealed || '').split('.');
            if (parts.length !== 4 || parts[0] !== 'v1') return null;
            try {
                const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'));
                d.setAAD(Buffer.from(String(subject || ''), 'utf8'));
                d.setAuthTag(Buffer.from(parts[2], 'base64url'));
                return Buffer.concat([d.update(Buffer.from(parts[3], 'base64url')), d.final()]).toString('utf8');
            } catch { return null; }
        },
    };
}

module.exports = { createSeal };
