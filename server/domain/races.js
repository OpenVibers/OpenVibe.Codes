'use strict';

/**
 * Race mode (compare-arena-ecosystem.md §5, "Votes where people already work"; plan §7 piece 5).
 *
 * One task, two harnesses, one budget:
 *
 *   const races = createRaces({ store, config, tasks, run, github, forge, fleet, harnesses, log });
 *   const race = await races.start({ subject, project, task, agents: ['codex', 'opencode'] });
 *   races.onTaskEnded(row)                 // a side's run_tasks row reached a terminal state
 *   races.applyCheck(check, event)         // one of the two check jobs ended
 *   races.handleGithubEvent(event)         // a pull request was merged (the implicit judge)
 *   races.checkMerges(race)                // the page's fallback read of GitHub
 *   races.present(race)                    // the run page's two sides
 *
 * The two sides are ordinary run_tasks rows (actor_ref->'race' names the race and the slot) started through
 * tasks.start with the same prompt, repository, ref and limits: two Run jobs on the person's machines, one budget
 * each. When both end, Codes runs the repository's own check workflow on each pushed branch through the check job
 * (harness/check.js, kind 'check' with a ref instead of a sha; the check discovers the workflow). The checks' results
 * become a test_suite judgement, and the whole comparison is recorded to OpenVibe.Bench as one bench.match@1.
 * The pull request the person merges later adds an implicit judgement to the SAME match id (Bench merges judgements
 * by id). Nothing here holds a Bench token: the service token asks Network for bench.judgement.cast on
 * audience openvibe.bench, and when that grant is absent the race still runs and only the match is skipped, with one
 * log line (the grant is added on Network separately).
 *
 * Entrants are agents: agent:<harness>+<model>#<16 hex of the canonical settings' sha256>, so a change of model,
 * permission or effort is a new entrant (bench.entrant@1).
 */
const crypto = require('crypto');
const { createServiceTokenClient } = require('openvibe-sdk/auth');

const RACE_STATE = new Set(['running', 'checking', 'finalizing', 'matched', 'skipped', 'failed']);
const CHECK_TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired', 'skipped']);
const TASK_TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
const CHECK_STATE = { queued: 'queued', placed: 'queued', running: 'running', succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled', expired: 'expired' };
const OUTCOME = { succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled', expired: 'timed_out' };
const BENCH_SCOPE = 'bench.judgement.cast';
const BENCH_AUDIENCE = 'openvibe.bench';

const asObject = (v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (typeof v === 'string') { try { const p = JSON.parse(v); return p && typeof p === 'object' && !Array.isArray(p) ? p : null; } catch { return null; } }
    return null;
};
const asArray = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
const int = (v) => (Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null);
const clampText = (v, max) => String(v == null ? '' : v).slice(0, max);

/** The canonical settings an agent entrant pins: sorted keys, null for what the side did not name. */
function settingsOf(side) {
    return {
        effort: side.effort || null,
        harness: side.agent || null,
        model: side.model || 'auto',
        permission: side.permission || 'edit',
    };
}

/** 16 hex of the sha256 of the settings' canonical JSON: the same settings always name the same entrant. */
function hashSettings(settings) {
    const canonical = {};
    for (const key of Object.keys(settings || {}).sort()) canonical[key] = settings[key] == null ? null : settings[key];
    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

/** The entrant id (bench.entrant@1): agent:<harness>+<model>#<settings hash>. */
function entrantOf(side) {
    const model = String(side.model || 'auto').replace(/[^A-Za-z0-9._/:-]/g, '-').slice(0, 200) || 'auto';
    const harness = String(side.agent || 'openvibe').replace(/[^a-z0-9._-]/g, '-').slice(0, 60) || 'openvibe';
    return `agent:${harness}+${model}#${hashSettings(settingsOf(side))}`;
}

/** A repository URL as owner/name, for matching a pull-request event to a race. */
function repoSlug(url) {
    try {
        const u = new URL(String(url || ''));
        const parts = u.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
        return parts.length === 2 ? `${parts[0]}/${parts[1]}`.toLowerCase() : null;
    } catch { return null; }
}

/** The tokens in a run's log, split in and out (when the log has none, receiptsOf keeps the total). */
function splitTokens(result) {
    const log = asArray(result && result.log);
    let tokensIn = 0;
    let tokensOut = 0;
    for (const line of log) {
        if (!line || typeof line !== 'object' || line.t !== 'usage') continue;
        tokensIn += Number(line.input_tokens) || 0;
        tokensOut += Number(line.output_tokens) || 0;
    }
    return { tokensIn: tokensIn || null, tokensOut: tokensOut || null };
}

/** The answer's style covariates (bench.match@1 receipts): its length and how much markdown it carries. */
function styleOf(text) {
    const s = String(text || '');
    const length = s.length || null;
    const items = (s.match(/^#{1,6}\s|^\s*[-*+]\s|^\s*\d+[.)]\s|\*\*[^*]+\*\*/gm) || []).length;
    return { length_chars: length, markdown_items: items || (length ? 0 : null) };
}

/** A side's receipts from its task and its last attempt: cost, tokens, wall time and tool calls. */
function receiptsOf(task, attempt, result) {
    const split = splitTokens(result);
    // A harness that reports one total (no usage lines) still contributes its tokens: the contract splits receipts
    // in and out, so the total goes in as the input side and the output side is zero, never a made-up split.
    const total = num(result && result.tokens) != null ? num(result.tokens) : (attempt && num(attempt.tokens));
    const tokensIn = split.tokensIn != null ? split.tokensIn : (total != null ? total : null);
    const tokensOut = split.tokensOut != null ? split.tokensOut : (total != null ? 0 : null);
    const started = attempt && attempt.started_at ? Date.parse(String(attempt.started_at)) : 0;
    const finished = attempt && attempt.finished_at ? Date.parse(String(attempt.finished_at)) : 0;
    const wall = started && finished > started ? finished - started : num(result && result.duration_ms);
    const toolCalls = attempt && Number.isInteger(Number(attempt.steps)) ? Number(attempt.steps) : null;
    const style = styleOf((asObject(result) || {}).summary);
    return {
        outcome: OUTCOME[task.state] || 'failed',
        cost_usd: attempt && num(attempt.cost_usd) != null ? num(attempt.cost_usd) : num(result && result.cost_usd),
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        wall_ms: wall == null ? null : Math.round(wall),
        tool_calls: toolCalls,
        length_chars: style.length_chars,
        markdown_items: style.markdown_items,
    };
}

/** A test-suite score from a check result: the share of the steps that passed, 0..1; null when it never ran. */
function scoreOf(result) {
    const doc = asObject(result);
    if (!doc || doc.kind !== 'check' || doc.conclusion === 'skipped') return null;
    const counted = asArray(doc.steps).filter((s) => s && ['success', 'failure', 'cancelled'].includes(s.conclusion));
    if (counted.length) return counted.filter((s) => s.conclusion === 'success').length / counted.length;
    return doc.conclusion === 'success' ? 1 : null;
}

/**
 * The OpenVibe.Bench recorder. It asks Network for bench.judgement.cast on audience openvibe.bench. A missing client,
 * a missing grant (Network's invalid_scope, or Bench's 401/403) is an `absent` answer, never a throw: the race ran,
 * and only the match is skipped. The caller logs one line.
 */
function createMatchRecorder({ config = {}, fetchImpl = globalThis.fetch, tokens = undefined, log = console } = {}) {
    const client = tokens !== undefined ? tokens : (config.oauth && config.oauth.clientSecret ? createServiceTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret, audience: BENCH_AUDIENCE, scope: BENCH_SCOPE, fetch: fetchImpl,
    }) : null);
    const url = `${String((config.bench && config.bench.url) || 'https://bench.openvibe.services').replace(/\/+$/, '')}/api/v1/matches`;
    async function record(match) {
        if (!client) return { ok: false, absent: true, reason: `Codes has no Network client credentials for ${BENCH_AUDIENCE}` };
        let headers;
        try {
            headers = await client.authHeaders();
        } catch (e) {
            return { ok: false, absent: true, reason: `Codes has no ${BENCH_SCOPE} on ${BENCH_AUDIENCE} (${clampText(e && e.message, 200)})` };
        }
        let res;
        try {
            res = await fetchImpl(url, {
                method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify(match), signal: AbortSignal.timeout(20000),
            });
        } catch (e) {
            return { ok: false, error: `Bench did not answer: ${clampText(e && e.message, 200)}` };
        }
        const doc = await res.json().catch(() => null);
        if (res.status === 401 || res.status === 403) {
            return { ok: false, absent: true, reason: `Bench refused ${BENCH_SCOPE} (${res.status})` };
        }
        if (!res.ok) return { ok: false, error: `Bench answered ${res.status}${doc && doc.detail ? `: ${clampText(doc.detail, 200)}` : ''}` };
        return { ok: true, created: doc ? doc.created !== false : undefined, match: doc && doc.match ? doc.match : match };
    }
    return { record, enabled: !!client, url };
}

/**
 * The bench.match@1 a race records: source codes, task kind code, the two sides as agent entrants with their receipts,
 * the shown order, the same budget for both, and the test_suite judgement when the checks answered. A merged side is
 * added as an implicit judgement before the first write when it is already known.
 */
function buildMatch(race, sides, { at = null, mergedSlot = null } = {}) {
    const slots = sides.map((side) => ({
        slot: side.slot,
        entrant: side.entrant || entrantOf(side),
        run_id: side.task_id || null,
        receipts: side.receipts || undefined,
    }));
    const judgements = [];
    const scores = {};
    for (const side of sides) {
        if (side.check && Number.isFinite(Number(side.check.score))) scores[side.slot] = Math.min(1, Math.max(0, Number(side.check.score)));
    }
    if (Object.keys(scores).length) {
        const best = Math.max(...Object.values(scores));
        const winners = Object.keys(scores).filter((slot) => scores[slot] === best);
        judgements.push({
            judge: 'test_suite', winner: winners.length === 1 ? winners[0] : 'tie', scores,
            by: { type: 'suite' }, at: at || new Date(race.created_at).toISOString(),
        });
    }
    if (mergedSlot && slots.some((x) => x.slot === mergedSlot)) {
        judgements.push({ judge: 'implicit', winner: mergedSlot, signal: 'merged', by: { type: 'person' }, at: at || new Date().toISOString() });
    }
    const promptHash = crypto.createHash('sha256').update(String(race.prompt || '')).digest('hex');
    const budget = asObject(race.budget) || {};
    const when = at || new Date(race.created_at).toISOString();
    return {
        id: race.match_id,
        source: 'codes',
        task: {
            kind: 'code', category: 'code.change', prompt_hash: promptHash, public: false,
            repo: clampText(race.repo, 300),
        },
        slots,
        shown: asArray(race.shown).length ? asArray(race.shown) : slots.map((x) => x.slot),
        blind: false,
        budget: { usd: num(budget.usd), ms: int(budget.ms), machine_class: null },
        judgements,
        at: when,
    };
}

function createRaces({ store, config = {}, run = null, tasks = null, github = null, forge = null, fleet = null, harnesses = null, fetchImpl = globalThis.fetch, log = console, now = null, random = Math.random, recorder = null } = {}) {
    if (!store) throw new TypeError('races need a store');
    const db = store.db;
    const clock = now || (() => store.now());
    const bench = recorder || createMatchRecorder({ config, fetchImpl, log });
    const finalizing = new Set();

    const byId = (id) => db.maybe('SELECT * FROM codes_races WHERE id = $1', [id]);
    const iso = (ms) => new Date(Number(ms)).toISOString();

    async function updateSides(race, sides) {
        return await db.one('UPDATE codes_races SET sides = $2::jsonb, updated_at = $3 WHERE id = $1 RETURNING *', [race.id, JSON.stringify(sides), clock()]);
    }

    async function updateSide(race, slot, patch) {
        const sides = asArray(race.sides).map((side) => (side.slot === slot ? { ...side, ...patch } : side));
        return await updateSides(race, sides);
    }

    /** Two harnesses the person can run: from their fleet when it answers, else the catalog's first two capable ones. */
    async function suggest(subject) {
        const catalog = harnesses ? harnesses.list().map((h) => h.id) : [];
        const usable = (id) => !catalog.length || catalog.includes(id);
        let ids = [];
        if (fleet && subject) {
            try {
                const rows = await fleet.agents(subject, harnesses);
                ids = rows.filter((row) => row && row.installed !== false && !['full', 'empty', 'offline'].includes(row.state))
                    .map((row) => row.agent).filter(usable);
            } catch { /* no fleet: the catalog answers */ }
        }
        const unique = [...new Set(ids)];
        if (unique.length >= 2) return unique.slice(0, 2);
        if (!unique.length) {
            const capable = harnesses ? harnesses.list().filter((h) => h.capabilities && h.capabilities.edit).map((h) => h.id) : [];
            unique.push(...(capable.length >= 2 ? capable.slice(0, 2) : ['codex', 'opencode'].filter(usable)));
        }
        for (const id of catalog) {
            if (unique.length >= 2) break;
            if (!unique.includes(id)) unique.push(id);
        }
        return unique.slice(0, 2);
    }

    function checkAgent(agent) {
        if (!harnesses) return;
        if (!harnesses.list().some((h) => h.id === agent)) {
            const error = new Error(`${agent} is not a harness in GET /api/v1/harnesses`);
            error.code = 'codes.agent_unknown';
            throw error;
        }
    }

    /** Start a race: two tasks, the same brief and repository and limits, one budget each, on the person's machines. */
    async function start({ subject, project, task = null, agents = null, prompt = null, repo = null, ref = null, permission = 'edit', effort = null, model = null, limits = null, mode = null, via = null } = {}) {
        if (!subject || !project) throw Object.assign(new Error('a race needs the person and their project'), { code: 'codes.race_invalid' });
        const chosen = asArray(agents).map(String).filter(Boolean).slice(0, 2);
        let pair = chosen.length === 2 ? chosen : await suggest(subject);
        if (chosen.length === 1) pair = [chosen[0], ...pair.filter((id) => id !== chosen[0])].slice(0, 2);
        if (pair.length < 2 || pair[0] === pair[1]) throw Object.assign(new Error('a race needs two different harnesses'), { code: 'codes.race_agents' });
        for (const agent of pair) checkAgent(agent);
        const raceId = store.newId('rce');
        const matchId = store.newId('mat');
        const at = clock();
        // One budget for both: the source task's first attempt when racing an existing task, else the limits named.
        let same = limits && typeof limits === 'object' ? { ...limits } : null;
        if (!same && task && tasks && tasks.attempts) {
            const first = (await tasks.attempts.list(task.id))[0] || null;
            if (first && (num(first.budget_usd) != null || num(first.budget_tokens) != null)) {
                same = { usd: num(first.budget_usd), tokens: num(first.budget_tokens) };
            }
        }
        const baseArgs = {
            repo: repo || (task && task.repo), ref: ref != null ? ref : (task && task.ref), prompt: prompt || (task && task.prompt),
            permission: permission || (task && task.permission) || 'edit',
            ...(same ? { limits: same } : {}),
            ...(model || (task && task.model) ? { model: model || task.model } : {}),
            ...(effort ? { effort } : {}),
            push: { branch: null, pull_request: true },
        };
        if (!baseArgs.repo || !baseArgs.prompt) throw Object.assign(new Error('a race needs a repository and a prompt'), { code: 'codes.race_invalid' });
        const shown = pair.map((_, i) => String.fromCharCode(97 + i));
        for (let i = shown.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [shown[i], shown[j]] = [shown[j], shown[i]];
        }
        const sides = pair.map((agent, index) => {
            const slot = String.fromCharCode(97 + index);
            return {
                slot, agent, model: baseArgs.model || null, effort: baseArgs.effort || null,
                permission: baseArgs.permission, task_id: null, state: 'queued',
                branch: null, pr_url: null, pr_number: null, receipts: null,
                check: { state: 'pending', score: null, conclusion: null },
                entrant: entrantOf({ agent, model: baseArgs.model || null, effort: baseArgs.effort || null, permission: baseArgs.permission }),
            };
        });
        const budget = { usd: num(same && same.usd), tokens: num(same && same.tokens), ms: int(same && same.ms) };
        await db.exec(
            `INSERT INTO codes_races (id, subject, project_id, source_task_id, repo, ref, prompt, permission, budget, sides, shown, state, match_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, 'running', $12, $13, $13)`,
            [raceId, subject, project, task ? task.id : null, baseArgs.repo, baseArgs.ref || null, baseArgs.prompt, baseArgs.permission,
                JSON.stringify(budget), JSON.stringify(sides), JSON.stringify(shown), matchId, at],
        );
        let race = await byId(raceId);
        for (const side of sides) {
            try {
                const row = await tasks.start({
                    subject, project,
                    args: {
                        repo: baseArgs.repo, ref: baseArgs.ref || null, prompt: baseArgs.prompt, agent: side.agent,
                        model: baseArgs.model || null, permission: baseArgs.permission, effort: baseArgs.effort || null,
                        // A race side is never re-planned: the person chose the two harnesses.
                        race: true,
                        ...(same ? { limits: same } : {}),
                        // The two jobs must not choose the same branch name, and each race side has its own.
                        push: { branch: `openvibe-codes/${String(raceId).slice(-10)}-${side.slot}`, pull_request: true },
                    },
                    via, key: `${raceId}-${side.slot}`, actorRef: { race: { id: raceId, slot: side.slot, match: matchId } }, mode,
                });
                const next = asArray(race.sides).map((x) => (x.slot === side.slot ? { ...x, task_id: row.id, state: row.state } : x));
                race = await updateSides(race, next);
            } catch (e) {
                log.warn(`[Codes] race ${raceId}: side ${side.slot} (${side.agent}) did not start: ${clampText(e && e.message, 300)}`);
                race = await updateSide(race, side.slot, { state: 'failed', error: clampText(e && e.message, 500) });
            }
        }
        const started = asArray(race.sides).filter((s) => s.task_id).length;
        if (started < 2) {
            race = await db.one(`UPDATE codes_races SET state = 'failed', error = $2, updated_at = $3 WHERE id = $1 RETURNING *`,
                [raceId, `only ${started} of 2 race jobs started`, clock()]);
        }
        return race;
    }

    /** A race started from a finished (or running) task: "Race this task". */
    async function startFromTask(task, { agents = null, effort = null, model = null, limits = null, mode = null, via = null } = {}) {
        if (!task) throw Object.assign(new Error('no such task'), { code: 'codes.task_not_found' });
        return await start({
            subject: task.subject, project: task.project_id, task, agents, effort, model, limits,
            permission: 'edit', mode, via,
        });
    }

    /** The race a task is a side of, or null. */
    async function ofTask(task) {
        const ref = asObject(task && task.actor_ref);
        const raceRef = ref && asObject(ref.race);
        return raceRef && raceRef.id ? await byId(raceRef.id) : null;
    }

    /** One side's run_tasks row and its last attempt, read fresh. */
    async function sideTask(side) {
        if (!side || !side.task_id) return { task: null, attempt: null };
        const task = await db.maybe('SELECT * FROM run_tasks WHERE id = $1', [side.task_id]);
        const attempt = task ? (await tasks.attempts.list(task.id)).slice(-1)[0] || null : null;
        return { task, attempt };
    }

    /** The side after its task ended: state, the pushed branch and pull request, the resolved model, the receipts. */
    async function sideAfterEnd(race, side) {
        const { task, attempt } = await sideTask(side);
        if (!task) return side;
        const result = asObject(task.result) || {};
        const push = asObject(result.push) || {};
        const model = clampText(result.resolved_model || (attempt && attempt.model) || side.model || '', 200) || null;
        const next = {
            ...side, state: task.state, model,
            branch: push.branch || side.branch || null,
            pr_url: push.pull_request || side.pr_url || null,
            pr_number: push.pull_request ? Number((/\/pull\/(\d+)/.exec(push.pull_request) || [])[1]) || null : side.pr_number,
            receipts: receiptsOf(task, attempt, result),
        };
        next.entrant = entrantOf(next);
        return next;
    }

    async function bothEnded(race) {
        const sides = asArray(race.sides);
        if (sides.length !== 2) return false;
        for (const side of sides) {
            const { task } = await sideTask(side);
            if (!task || !TASK_TERMINAL.has(task.state)) return false;
        }
        return true;
    }

    /** A side's task reached a terminal state: keep its side, and when both have, run the checks. */
    async function onTaskEnded(row) {
        const ref = asObject(row && row.actor_ref);
        const raceRef = ref && asObject(ref.race);
        if (!raceRef || !raceRef.id) return row;
        let race = await byId(raceRef.id);
        if (!race) return row;
        const sides = [];
        for (const side of asArray(race.sides)) sides.push(side.slot === raceRef.slot ? await sideAfterEnd(race, side) : side);
        race = await updateSides(race, sides);
        if (race.state !== 'running') return row;
        if (!(await bothEnded(race))) return row;
        const claimed = await db.maybe("UPDATE codes_races SET state = 'checking', updated_at = $2 WHERE id = $1 AND state = 'running' RETURNING *", [race.id, clock()]);
        if (!claimed) return row;
        await runChecks(claimed);
        return row;
    }

    /** Start the repository's check on each side's pushed branch (the check job discovers the workflow). */
    async function runChecks(race) {
        if (!run || !run.submit) {
            await finishRace(race.id, { reason: 'Codes has no Run client to start the check jobs' });
            return;
        }
        for (const side of asArray(race.sides)) {
            if (side.check && CHECK_TERMINAL.has(side.check.state)) continue;
            if (!side.branch) {
                await skipCheck(race.id, side.slot, 'the side did not push a branch to check');
                continue;
            }
            const existing = await db.maybe('SELECT * FROM codes_race_checks WHERE race_id = $1 AND slot = $2', [race.id, side.slot]);
            if (existing && existing.job_id) continue;
            const checkId = existing ? existing.id : store.newId('rch');
            if (!existing) {
                await db.exec(
                    `INSERT INTO codes_race_checks (id, race_id, slot, subject, project_id, repo, ref, state, created_at, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $8) ON CONFLICT (race_id, slot) DO NOTHING`,
                    [checkId, race.id, side.slot, race.subject, race.project_id, race.repo, side.branch, clock()],
                );
            }
            try {
                // A repository on OpenVibe Git is checked with the person's credential line, as a code job is; a
                // GitHub repository uses the machine's own GITHUB_TOKEN.
                const git = forge && forge.jobEnv ? await forge.jobEnv(race.subject, race.repo).catch(() => null) : null;
                const job = await run.submit({
                    subject: race.subject, project: race.project_id,
                    args: { kind: 'check', repo: race.repo, ref: side.branch, event: 'pull_request', ...(git ? { env: git } : {}) },
                    key: checkId,
                });
                await db.exec('UPDATE codes_race_checks SET job_id = $2, state = $3, updated_at = $4 WHERE id = $1',
                    [checkId, job.id, CHECK_STATE[job.state] || 'queued', clock()]);
                race = await updateSide(race, side.slot, { check: { id: checkId, state: CHECK_STATE[job.state] || 'queued', job_id: job.id, score: null } });
            } catch (e) {
                log.warn(`[Codes] race ${race.id}: the check for side ${side.slot} did not start: ${clampText(e && e.message, 300)}`);
                await skipCheck(race.id, side.slot, `the check job did not start: ${clampText(e && e.message, 300)}`);
            }
        }
        await maybeFinish(race.id);
    }

    async function skipCheck(raceId, slot, reason) {
        const check = await db.maybe('SELECT * FROM codes_race_checks WHERE race_id = $1 AND slot = $2', [raceId, slot]);
        if (check && CHECK_TERMINAL.has(check.state)) return;
        if (check) {
            await db.exec("UPDATE codes_race_checks SET state = 'skipped', error = $2, updated_at = $3 WHERE id = $1", [check.id, clampText(reason, 500), clock()]);
        }
        const race = await byId(raceId);
        if (!race) return;
        await updateSide(race, slot, { check: { ...(check ? { id: check.id } : {}), state: 'skipped', reason: clampText(reason, 500), score: null } });
    }

    /** A run.job.* event of a check job: its result, then the race's test judgement when both sides answered. */
    async function applyCheck(check, { state, job = null, error = null } = {}) {
        const next = CHECK_STATE[state] || 'failed';
        if (CHECK_TERMINAL.has(check.state)) return check;
        const result = asObject(job && job.result) || null;
        const updated = await db.one(
            `UPDATE codes_race_checks SET state = $2, result = $3::jsonb, error = $4, updated_at = $5 WHERE id = $1 RETURNING *`,
            [check.id, next, result ? JSON.stringify(result) : null, error ? clampText(error, 1000) : null, clock()],
        );
        const race = await byId(updated.race_id);
        if (!race) return updated;
        const score = scoreOf(updated.result);
        await updateSide(race, updated.slot, {
            check: {
                id: updated.id, state: updated.state, job_id: updated.job_id, conclusion: (updated.result && updated.result.conclusion) || null,
                score, reason: updated.error || (updated.result && updated.result.reason) || null,
                steps: asArray(updated.result && updated.result.steps).length || null,
            },
        });
        await maybeFinish(race.id);
        return updated;
    }

    /** When every check answered, build and record the match (once). */
    async function maybeFinish(raceId) {
        if (finalizing.has(raceId)) return;
        let race = await byId(raceId);
        if (!race || race.state !== 'checking') return;
        const checks = await db.many('SELECT * FROM codes_race_checks WHERE race_id = $1', [raceId]);
        if (checks.some((c) => !CHECK_TERMINAL.has(c.state))) return;
        // A side with no branch has no check row: its side says skipped, and that is an answer too.
        if (asArray(race.sides).some((side) => side.check && !CHECK_TERMINAL.has(side.check.state) && !checks.some((c) => c.slot === side.slot))) return;
        finalizing.add(raceId);
        try {
            const claimed = await db.maybe("UPDATE codes_races SET state = 'finalizing', updated_at = $2 WHERE id = $1 AND state = 'checking' RETURNING *", [raceId, clock()]);
            if (!claimed) return;
            await finishRace(claimed.id);
        } finally {
            finalizing.delete(raceId);
        }
    }

    /** The match body from the two finished sides, recorded to Bench; no grant is a skip with one log line. */
    async function finishRace(raceId, { reason = null } = {}) {
        let race = await byId(raceId);
        if (!race) return null;
        const sides = [];
        for (const side of asArray(race.sides)) {
            const finished = await sideAfterEnd(race, side);
            const check = await db.maybe('SELECT * FROM codes_race_checks WHERE race_id = $1 AND slot = $2', [race.id, side.slot]);
            const score = check ? scoreOf(check.result) : null;
            sides.push({ ...finished, check: { ...(finished.check || {}), state: check ? check.state : 'skipped', score, conclusion: check && check.result ? check.result.conclusion : null } });
        }
        race = await updateSides(race, sides);
        const body = buildMatch(race, sides, { mergedSlot: race.merged_slot || null, at: iso(clock()) });
        await db.exec('UPDATE codes_races SET match_body = $2::jsonb, updated_at = $3 WHERE id = $1', [race.id, JSON.stringify(body), clock()]);
        const recorded = await bench.record(body);
        if (!recorded.ok) {
            const skipped = !!recorded.absent;
            const why = recorded.reason || recorded.error || reason || 'the match was not recorded';
            log.warn(`[Codes] race ${race.id}: ${skipped ? 'match skipped' : 'match not recorded'}: ${clampText(why, 300)}`);
            await db.exec(`UPDATE codes_races SET state = $2, error = $3, updated_at = $4 WHERE id = $1`,
                [race.id, skipped ? 'skipped' : 'failed', clampText(why, 1000), clock()]);
            return null;
        }
        await db.exec(`UPDATE codes_races SET state = 'matched', match_recorded = true, merged_judged = $2, error = NULL, updated_at = $3 WHERE id = $1`,
            [race.id, !!(race.merged_slot), clock()]);
        return recorded.match || body;
    }

    /** The merge: one implicit judgement, added to the same match id. Before the match exists it waits in the body. */
    async function judgeMerged(race, slot) {
        if (!race || !slot) return null;
        if (race.merged_judged) return null;
        if (!race.match_recorded) {
            await db.exec('UPDATE codes_races SET merged_slot = $2, updated_at = $3 WHERE id = $1 AND merged_slot IS NULL', [race.id, slot, clock()]);
            return null;
        }
        const body = asObject(race.match_body);
        if (!body) return null;
        const already = asArray(body.judgements).some((j) => j && j.judge === 'implicit' && j.signal === 'merged');
        if (!already) {
            body.judgements = [...asArray(body.judgements), { judge: 'implicit', winner: slot, signal: 'merged', by: { type: 'person' }, at: iso(clock()) }];
        }
        await db.exec('UPDATE codes_races SET match_body = $2::jsonb, merged_slot = $3, updated_at = $4 WHERE id = $1', [race.id, JSON.stringify(body), slot, clock()]);
        if (already) {
            await db.exec('UPDATE codes_races SET merged_judged = true, updated_at = $2 WHERE id = $1', [race.id, clock()]);
            return null;
        }
        const recorded = await bench.record(body);
        if (!recorded.ok) {
            log.warn(`[Codes] race ${race.id}: merged judgement ${recorded.absent ? 'skipped' : 'not recorded'}: ${clampText(recorded.reason || recorded.error, 300)}`);
            await db.exec('UPDATE codes_races SET merged_judged = true, updated_at = $2 WHERE id = $1', [race.id, clock()]);
            return null;
        }
        await db.exec('UPDATE codes_races SET merged_judged = true, updated_at = $2 WHERE id = $1', [race.id, clock()]);
        return body;
    }

    /**
     * A GitHub delivery through OpenVibe.Events: github.pr.updated with action closed and merged true. The pull
     * request's repository and number find the race side; the judgement goes to the same match id.
     */
    async function handleGithubEvent(event) {
        if (!event || event.event_type !== 'github.pr.updated') return { outcome: 'ignored:not-a-merge', race_ids: [] };
        const payload = asObject(event.payload) || {};
        if (payload.action !== 'closed' || payload.merged !== true) return { outcome: 'ignored:not-a-merge', race_ids: [] };
        const subject = asObject(event.subject);
        const m = subject && typeof subject.id === 'string' ? /^([a-z0-9-]+\/[a-z0-9._-]+)#(\d+)$/i.exec(subject.id) : null;
        if (!m) return { outcome: 'ignored:payload', race_ids: [] };
        const slug = m[1].toLowerCase();
        const number = Number(m[2]);
        const rows = await db.many("SELECT * FROM codes_races WHERE merged_slot IS NULL AND state IN ('running', 'checking', 'finalizing', 'matched') ORDER BY created_at DESC LIMIT 100");
        for (const race of rows) {
            if (repoSlug(race.repo) !== slug) continue;
            const side = asArray(race.sides).find((x) => Number(x.pr_number) === number);
            if (!side) continue;
            await db.exec('UPDATE codes_races SET merged_slot = $2, updated_at = $3 WHERE id = $1', [race.id, side.slot, clock()]);
            await judgeMerged({ ...race, merged_slot: side.slot }, side.slot);
            return { outcome: 'race:merged', race_ids: [race.id], slot: side.slot };
        }
        return { outcome: 'ignored:no_race', race_ids: [] };
    }

    /** The page's fallback: read the two pull requests from GitHub; a merged one is the implicit judgement. */
    async function checkMerges(race) {
        if (!github || !github.pullRequest || !race) return race;
        for (const side of asArray(race.sides)) {
            if (!side.pr_url || (race.merged_slot === side.slot)) continue;
            try {
                const pr = await github.pullRequest(side.pr_url);
                if (pr && pr.merged === true) {
                    await db.exec('UPDATE codes_races SET merged_slot = $2, updated_at = $3 WHERE id = $1 AND merged_slot IS NULL', [race.id, side.slot, clock()]);
                    await judgeMerged((await byId(race.id)) || race, side.slot);
                    return await byId(race.id);
                }
            } catch (e) {
                log.warn(`[Codes] race ${race.id}: the pull request ${side.pr_url} could not be read: ${clampText(e && e.message, 200)}`);
            }
        }
        return race;
    }

    /** The race as the run page and the API present it. */
    function present(race) {
        if (!race) return null;
        return {
            id: race.id, state: race.state, repo: race.repo, ref: race.ref || null, prompt: race.prompt,
            source_task_id: race.source_task_id || null, budget: asObject(race.budget) || {},
            shown: asArray(race.shown), merged_slot: race.merged_slot || null,
            match: { id: race.match_id, recorded: !!race.match_recorded, state: race.match_recorded ? 'recorded' : (race.state === 'skipped' ? 'skipped' : race.state), error: race.error || null },
            sides: asArray(race.sides).map((side) => ({
                slot: side.slot, task_id: side.task_id || null, agent: side.agent, model: side.model || null,
                entrant: side.entrant || entrantOf(side), state: side.state, branch: side.branch || null,
                pull_request: side.pr_url || null, receipts: side.receipts || null,
                check: side.check || null, error: side.error || null,
            })),
            created_at: iso(race.created_at), updated_at: iso(race.updated_at),
        };
    }

    return {
        start, startFromTask, ofTask, onTaskEnded, applyCheck, runChecks, maybeFinish, finishRace,
        judgeMerged, handleGithubEvent, checkMerges, present, byId, suggest, sideTask,
        bench, enabled: !!run,
    };
}

module.exports = {
    createRaces, createMatchRecorder, buildMatch, entrantOf, settingsOf, hashSettings, receiptsOf, scoreOf, repoSlug,
    BENCH_SCOPE, BENCH_AUDIENCE, RACE_STATE, CHECK_TERMINAL, TASK_TERMINAL,
};
