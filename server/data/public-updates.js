'use strict';
// Public feed only: bounded wait, five-minute cache, and the last good response on failure.
function createPublicUpdates({ base, fetchImpl = globalThis.fetch }) {
    let cached = [], expires = 0, pending = null;
    return async function updates() {
        if (Date.now() < expires) return cached;
        if (pending) return pending;
        pending = (async () => {
            try {
                const response = await fetchImpl(`${base}/api/v1/changelog?service=codes&limit=50`, { signal: AbortSignal.timeout(2000), headers: { Accept: 'application/json' } });
                if (response.ok) {
                    const data = await response.json();
                    if (Array.isArray(data.entries)) cached = data.entries.filter(e => typeof e.subject === 'string' && /^https:\/\/github.com\/OpenVibers\//.test(e.url || '')).slice(0, 50);
                }
            } catch { /* The public page still renders the last successful feed. */ }
            expires = Date.now() + 300000;
            return cached;
        })().finally(() => { pending = null; });
        return pending;
    };
}
module.exports = { createPublicUpdates };
