'use strict';

/**
 * Where the harness keeps its runs on the person's machine (never on a server):
 *
 *   $OPENVIBE_CODES_HOME, else $XDG_STATE_HOME/openvibe-codes, else ~/.local/state/openvibe-codes
 *     runs/<run id>.jsonl      every event of the run, each tagged with its attempt and agent
 *     runs/<run id>.json       the run's summary: prompt (first 500 characters), working directory, attempts, result
 *     sessions/<id>.json       an API agent's conversation, so `resume` continues it
 *
 * Files are created 0600 in 0700 directories: a run's events can quote the code it worked on.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function homeDir(env = process.env) {
    if (env.OPENVIBE_CODES_HOME) return path.resolve(env.OPENVIBE_CODES_HOME);
    const state = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
    return path.join(state, 'openvibe-codes');
}

function createStore({ env = process.env } = {}) {
    const root = homeDir(env);
    const dir = (name) => { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };
    const safe = (id) => String(id).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 120);
    const write = (file, text) => fs.writeFileSync(file, text, { mode: 0o600 });

    return {
        root,
        newRunId: () => `run_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 8)}`,
        appendEvent(runId, event) { fs.appendFileSync(path.join(dir('runs'), `${safe(runId)}.jsonl`), `${JSON.stringify(event)}\n`, { mode: 0o600 }); },
        saveRun(runId, summary) { write(path.join(dir('runs'), `${safe(runId)}.json`), `${JSON.stringify(summary, null, 2)}\n`); },
        loadRun(runId) { try { return JSON.parse(fs.readFileSync(path.join(dir('runs'), `${safe(runId)}.json`), 'utf8')); } catch { return null; } },
        events(runId) {
            try { return fs.readFileSync(path.join(dir('runs'), `${safe(runId)}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
        },
        listRuns(limit = 20) {
            const d = dir('runs');
            return fs.readdirSync(d).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, limit)
                .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { return null; } }).filter(Boolean);
        },
        load(sessionId) { try { return JSON.parse(fs.readFileSync(path.join(dir('sessions'), `${safe(sessionId)}.json`), 'utf8')); } catch { return null; } },
        save(sessionId, data) { write(path.join(dir('sessions'), `${safe(sessionId)}.json`), JSON.stringify(data)); },
    };
}

module.exports = { createStore, homeDir };
