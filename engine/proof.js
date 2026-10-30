'use strict';

/**
 * Proof collection for a finished attempt. The Node runner supplies the command, screenshot and review adapters;
 * keeping those effects injected makes the sequence deterministic in tests and lets each step be reported live.
 */
const WEB_FILE = /(?:^public\/|\.html?$|\.css$)/i;

async function collectProof({ cwd, run, screenshot, review, authorFamily, emit = async () => {} }) {
    if (!cwd || typeof run !== 'function' || typeof screenshot !== 'function' || typeof review !== 'function') {
        throw new TypeError('cwd, run, screenshot and review adapters are required');
    }
    const items = [];
    const record = async (item) => { items.push(item); await emit(item); };
    const command = async (label, argv) => {
        const result = await run(argv, { cwd });
        return { label, command: argv.join(' '), passed: result.code === 0, exit_code: result.code,
            summary: String(result.output || '').slice(-4000) };
    };

    const packageInfo = await run(['node', '-e', "const p=require('./package.json');process.stdout.write(JSON.stringify(p.scripts||{}))"], { cwd });
    let scripts = {};
    if (packageInfo.code === 0) { try { scripts = JSON.parse(packageInfo.output || '{}'); } catch { /* no package scripts */ } }
    let test;
    if (scripts.test && !/OV_ALLOW_SUITE/i.test(scripts.test)) {
        test = await command('tests', ['npm', 'test']);
    } else if (scripts.test && /OV_ALLOW_SUITE/i.test(scripts.test) && process.env.OV_ALLOW_SUITE === '1') {
        test = await command('tests', ['npm', 'test']);
    } else {
        const probes = [
            ['pnpm-lock.yaml', ['pnpm', 'test']], ['go.mod', ['go', 'test', './...']],
            ['pytest.ini', ['pytest']], ['pyproject.toml', ['pytest']],
        ];
        const found = await run(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], { cwd });
        const files = new Set(String(found.output || '').split('\n'));
        const candidate = probes.find(([file]) => files.has(file));
        test = candidate ? await command('tests', candidate[1]) : { label: 'tests', passed: false, summary: 'No supported test command was found.' };
    }
    await record(test);

    const changed = await run(['git', 'diff', '--name-only', 'HEAD'], { cwd });
    const webFiles = String(changed.output || '').split('\n').filter((f) => f && WEB_FILE.test(f));
    for (const width of webFiles.length ? [390, 1440] : []) {
        const shot = await screenshot({ cwd, width, files: webFiles });
        await record({ label: 'screenshot', width, path: shot.path || null, passed: shot.passed === true,
            summary: String(shot.summary || '').slice(0, 1000) });
    }
    const stats = await run(['git', 'diff', '--stat', 'HEAD'], { cwd });
    const diff = await run(['git', 'diff', '--no-ext-diff', 'HEAD'], { cwd });
    await record({ label: 'diff', stats: String(stats.output || '').slice(0, 4000), patch: String(diff.output || '').slice(0, 262144),
        passed: stats.code === 0 && diff.code === 0 });

    const verdict = await review({ cwd, patch: String(diff.output || ''), authorFamily });
    if (!verdict || !verdict.family || verdict.family === authorFamily) throw new Error('review must come from a different model family');
    await record({ label: 'review', family: String(verdict.family).slice(0, 80), verdict: verdict.verdict === 'approved' ? 'approved' : 'changes_requested',
        summary: String(verdict.summary || '').slice(0, 4000), passed: verdict.verdict === 'approved' });

    const complete = items.every((item) => item.passed === true);
    return { items, outcome: complete ? 'Done with proof' : 'Didn’t finish',
        remaining: complete ? null : items.filter((item) => !item.passed).map((item) => item.label) };
}

module.exports = { collectProof };
