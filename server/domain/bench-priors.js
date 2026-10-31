'use strict';

/**
 * Bench priors for placement (agent plan A1, section 6): Bench's quality score per model on the kind of task Codes is
 * placing, cached for an hour. Codes asks the SDK's Bench client for the board; a Bench that does not answer leaves
 * the priors empty, so place() uses its 0.7 default (0.5 on the floor) and the task still runs.
 *
 *   createBenchPriors({ config, fetchImpl, now, log }) →
 *     forTask('edit' | 'review') → { [model]: quality }   one board read per kind per hour
 *     enabled
 *
 * The board is public (no token) and carries `quality` in [0, 1] per model (Bench's pareto board). Codes maps Bench
 * kind codes.patch to edit and codes.review to review; a model Bench has not seen simply has no prior.
 */
const { createClient } = require('openvibe-sdk/core');
const { createBenchClient } = require('openvibe-sdk/bench');

const TTL_MS = 60 * 60_000;
const BENCH_KIND = { edit: 'codes.patch', review: 'codes.review' };

function createBenchPriors({ config = {}, fetchImpl = globalThis.fetch, now = Date.now, log = console, ttlMs = TTL_MS } = {}) {
    const bench = config.bench || {};
    const enabled = bench.priors !== false && !!bench.url;
    const client = enabled
        ? createBenchClient(createClient({ baseUrls: { bench: bench.url }, autoDiscover: false, fetch: fetchImpl, timeoutMs: 4000, retries: 0 }), { baseUrl: bench.url })
        : null;
    const cache = new Map();   // Bench kind → { at, scores }

    async function scoresOf(kind) {
        const hit = cache.get(kind);
        if (hit && now() - hit.at < ttlMs) return hit.scores;
        let scores = {};
        try {
            const { board } = await client.boards.get(kind, { type: 'pareto' });
            for (const row of (board && Array.isArray(board.rows) ? board.rows : [])) {
                const q = Number(row && row.quality);
                if (row && typeof row.subject === 'string' && Number.isFinite(q)) scores[row.subject] = Math.max(0, Math.min(1, q));
            }
        } catch (e) {
            log.warn(`[Codes] Bench priors for ${kind} unavailable: ${String((e && e.message) || e).slice(0, 160)}`);
        }
        cache.set(kind, { at: now(), scores });
        return scores;
    }

    async function forTask(task) {
        if (!enabled) return {};
        const kind = BENCH_KIND[task];
        return kind ? await scoresOf(kind) : {};
    }

    return { enabled, forTask, BENCH_KIND };
}

module.exports = { createBenchPriors, BENCH_KIND, TTL_MS };
