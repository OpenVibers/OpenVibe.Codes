'use strict';

/**
 * The map a job gets instead of a raw directory tree.
 *
 * Ported from the portal's know/repomap.js: a job that works in one repository gets that repository's digest (what it
 * is, how it is laid out, the commands the docs state); a job that works in a folder holding many repositories gets
 * nothing, because the raw tree was a thousand lines of .npm-cache and .git noise.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_LINES = 120;
const MAX_FILE = 24 * 1024;

/** git in a folder, its output or ''. */
function gitOut(dir, args) {
    try {
        const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 });
        return r.status === 0 ? String(r.stdout || '') : '';
    } catch { return ''; }
}

/** Is this a repository (a worktree's .git is a file)? */
function isRepo(dir) {
    try { const s = fs.statSync(path.join(dir, '.git')); return s.isDirectory() || s.isFile(); } catch { return false; }
}

/** The repositories inside a folder (one level down, and one more for the usual layout). */
function reposIn(dir) {
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const sub = path.join(dir, e.name);
        if (isRepo(sub)) { out.push(sub); continue; }
        let inner = [];
        try { inner = fs.readdirSync(sub, { withFileTypes: true }); } catch { continue; }
        for (const i of inner) {
            if (!i.isDirectory() || i.name.startsWith('.')) continue;
            const deep = path.join(sub, i.name);
            if (isRepo(deep)) out.push(deep);
        }
    }
    return out;
}

/** A short, stable key for a repository (its remote, or its path). */
function repoKey(dir) {
    const remote = gitOut(dir, ['config', '--get', 'remote.origin.url']).trim();
    if (remote) return remote.replace(/\.git$/, '');
    return path.resolve(dir);
}

/** The first lines of a file, or ''. */
function head(file, lines = 60) {
    try {
        const s = fs.statSync(file);
        if (!s.isFile() || s.size > MAX_FILE) return '';
        return fs.readFileSync(file, 'utf8').split('\n').slice(0, lines).join('\n').trim();
    } catch { return ''; }
}

/**
 * The digest of one repository: what it is, how it is laid out, the commands its docs state.
 *
 * @param {string} dir the repository's root
 * @returns {string} the digest ('' when there is none)
 */
function digest(dir) {
    const parts = [];
    const name = path.basename(dir);
    const pkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; } })();
    parts.push(`# ${name}`);
    if (pkg && pkg.description) parts.push(String(pkg.description));
    const readme = ['README.md', 'README', 'readme.md'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
    if (readme) {
        const text = head(readme, 40);
        if (text) parts.push(text);
    }
    // The layout: the top level, without the noise.
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
    const top = entries.filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
        .map((e) => (e.isDirectory() ? e.name + '/' : e.name)).slice(0, 40);
    if (top.length) parts.push(`Top level: ${top.join(', ')}`);
    if (pkg && pkg.scripts && typeof pkg.scripts === 'object') {
        const scripts = Object.entries(pkg.scripts).slice(0, 20).map(([k, v]) => `${k}: ${String(v).split('\n')[0]}`);
        if (scripts.length) parts.push(['Commands:', ...scripts].join('\n'));
    }
    const text = parts.join('\n\n');
    return text.split('\n').slice(0, MAX_LINES).join('\n');
}

/**
 * The map for a job's folder.
 *
 * @param {string} dir the folder the job works in
 * @returns {{text: string, kind: 'digest'|'workspace'|'none', repo: string|null}} the map
 */
function repomap(dir) {
    const d = path.resolve(String(dir || ''));
    if (!d || !fs.existsSync(d)) return { text: '', kind: 'none', repo: null };
    const top = gitOut(d, ['rev-parse', '--show-toplevel']).trim();
    if (top && fs.existsSync(top)) {
        const text = digest(top);
        return { text, kind: 'digest', repo: repoKey(top) };
    }
    const repos = reposIn(d);
    if (repos.length >= 2) return { text: '', kind: 'workspace', repo: null };
    if (repos.length === 1) {
        const text = digest(repos[0]);
        return { text, kind: 'digest', repo: repoKey(repos[0]) };
    }
    return { text: '', kind: 'none', repo: null };
}

module.exports = { repomap, digest, reposIn, repoKey, isRepo };
