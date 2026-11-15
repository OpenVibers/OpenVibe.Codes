'use strict';

/**
 * Every model OpenVibe.AI knows, read from AI's public model directory (GET /api/v1/exchange/directory, the same list
 * openvibe.exchange shows), so each coding agent offers every model it can run (the owner, 2026-11-15: "a lot of
 * harnesses [run] different models … Claude Code obviously has a bunch … there's like tons"). Read at start and every
 * 30 minutes in the background; a reader never waits for it (until the first answer, the agents keep their own short
 * lists). Off in a drill.
 *
 *   createModelDirectory({ config, fetchImpl, log }) → { start(), stop(), byMaker(), loaded() }
 *     byMaker() → Map maker → [{ model: 'claude-opus-5.5', name, context, price, vision }] newest first: chat models
 *     that can call tools (what a coding agent needs), no batch variants, nothing retired.
 */

const EVERY_MS = 30 * 60_000;

/** The version a model name carries: 'gpt-5.6-luna' → 5.6, 'qwen-2.5-72b-instruct' → 2.5, 'gpt-oss-120b' → 0. */
function versionOf(name) {
    const s = String(name).toLowerCase()
        .replace(/\d{4}-\d{2}-\d{2}/g, '').replace(/-\d{4}\b/g, '').replace(/\b\d{4}\b/g, '')
        .replace(/\b(a)?\d+(\.\d+)?[bmk]\b/g, '');
    const m = s.match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
}

function createModelDirectory({ config = {}, fetchImpl = globalThis.fetch, log = console, now = () => Date.now() } = {}) {
    const base = String((config.ai && config.ai.internalUrl) || '').replace(/\/+$/, '');
    let makers = new Map();
    let at = 0;
    let timer = null;

    function index(models) {
        const out = new Map();
        const seen = new Set();
        for (const m of models) {
            if (!m || typeof m.model !== 'string' || m.retired_at || m.status === 'retired') continue;
            if (m.type && !['chat', 'text'].includes(m.type)) continue;
            if (!(m.supports && m.supports.tools)) continue;
            if (/:batch$|:free$/.test(m.model)) continue;
            const [maker, name] = m.model.includes('/') ? m.model.split('/') : [String(m.provider || ''), m.model];
            if (!maker || !name || seen.has(`${maker}/${name}`)) continue;
            seen.add(`${maker}/${name}`);
            if (!out.has(maker)) out.set(maker, []);
            out.get(maker).push({
                model: name, maker, name: String(m.name || name).replace(/^[^:]+:\s*/, '').slice(0, 80),
                context: Number(m.context_window) || null,
                price: m.price && typeof m.price === 'object' ? m.price : null,
                vision: !!(m.supports && m.supports.vision),
                updated: String(m.updated_at || m.first_seen_at || ''),
            });
        }
        // Newest first within each maker: by the version in the name (the directory's dates are when it was first read, the
        // same for most), with sizes (120b), dates and snapshot numbers (-0613, 2507) not taken for a version; the plain
        // name before its variants.
        for (const list of out.values()) list.sort((a, b) => versionOf(b.model) - versionOf(a.model) || a.model.length - b.model.length || a.model.localeCompare(b.model));
        return out;
    }

    async function load() {
        if (!base) return;
        try {
            const res = await fetchImpl(`${base}/api/v1/exchange/directory`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = await res.json();
            if (!Array.isArray(body.models)) throw new Error('no models');
            makers = index(body.models);
            at = now();
        } catch (err) {
            (log.warn || log.log).call(log, `[codes] AI's model directory unavailable: ${String((err && err.message) || err).slice(0, 160)}`);
        }
    }

    return {
        start() {
            if (config.drill || timer) return;
            load();
            timer = setInterval(load, EVERY_MS);
            if (timer.unref) timer.unref();
        },
        stop() { if (timer) clearInterval(timer); timer = null; },
        load,
        byMaker: () => makers,
        loaded: () => at > 0,
        index,
    };
}

module.exports = { createModelDirectory, versionOf };
