'use strict';
/**
 * Per-turn diffs (plan §AD.6, Codes next (4)): what one attempt of a task changed by itself, from its job's result.
 *
 * The harness measures it (harness/job.js: result.checkpoints.turn_diff, the clone after the earlier turns' changes were
 * applied against the clone at the end; a path is authored when the turn's own tools wrote it). A harness without
 * checkpoints is compared file by file with the result of the turn before: a file whose counts moved, a new file, and a
 * file the turn put back. → { source, files: [{ path, status, added, removed, authored? }], truncated? } | null
 */
const MAX_FILES = 100;

const count = (v) => (Number.isInteger(v) && v >= 0 ? v : v == null ? null : (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : null));
const pathOf = (v) => (typeof v === 'string' && v && v.length <= 500 ? v : null);
const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const STATUS = new Set(['A', 'M', 'D', 'R', 'C', 'T']);

function of(result, before = null) {
    const r = asObject(result);
    if (!r) return null;
    const cp = asObject(r.checkpoints);
    const turn = cp && asObject(cp.turn_diff);
    if (turn && Array.isArray(turn.files)) {
        const files = turn.files.map((f) => asObject(f)).filter((f) => f && pathOf(f.path)).slice(0, MAX_FILES).map((f) => ({
            path: f.path,
            status: STATUS.has(String(f.status || '').charAt(0)) ? String(f.status).charAt(0) : 'M',
            added: count(f.added), removed: count(f.removed),
            authored: f.authored === true,
        }));
        return files.length ? { source: 'checkpoints', files, ...(turn.files.length > MAX_FILES || turn.truncated === true ? { truncated: true } : {}) } : null;
    }
    // No file list at all: the job ended before it measured anything (a crash), which is not "everything put back".
    if (!Array.isArray(r.files)) return null;
    const now = r.files.map((f) => asObject(f)).filter((f) => f && pathOf(f.path));
    const prev = new Map((Array.isArray(asObject(before) && before.files) ? before.files : []).map((f) => asObject(f)).filter((f) => f && pathOf(f.path)).map((f) => [f.path, f]));
    const files = [];
    for (const f of now) {
        const was = prev.get(f.path);
        if (was && count(was.added) === count(f.added) && count(was.removed) === count(f.removed)) continue;
        files.push({ path: f.path, status: was ? 'M' : 'A', added: count(f.added), removed: count(f.removed) });
    }
    const still = new Set(now.map((f) => f.path));
    for (const [path] of prev) if (!still.has(path)) files.push({ path, status: 'put back', added: null, removed: null });
    if (!files.length) return null;
    return { source: 'files', files: files.slice(0, MAX_FILES), ...(files.length > MAX_FILES ? { truncated: true } : {}) };
}

/** A stored value (jsonb, or its text) → the shape above, or null. */
function read(v) {
    let o = v;
    if (typeof v === 'string') { try { o = JSON.parse(v); } catch { return null; } }
    o = asObject(o);
    return o && Array.isArray(o.files) ? o : null;
}

module.exports = { of, read, MAX_FILES };
