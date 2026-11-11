'use strict';

/**
 * The small memory index: what the job remembers, from files beside the work.
 *
 * A repository keeps `MEMORY.md` (the index, always loaded) and `memory/<topic>.md` (one file per topic, loaded by
 * search). The index is cheap and stable, so every prompt carries it; a topic costs tokens, so only the topics the
 * brief's words point at ride along, most overlapping first. Everything is capped: an index is a pointer, not a dump.
 *
 * A folder with neither file gets nothing, never an error: memory is optional, and a job must not fail for lack of
 * remembering. The nightly dream pass (dedupe and correction against transcripts) and the receipt's cache-hit share
 * live on the Know side; this module is what Codes loads and what the dream pass reads back.
 *
 *   indexOf(dir)                      the index text, capped, or ''
 *   topics(dir)                       every topic file: [{ topic, text }]
 *   search(dir, query)                topics by word overlap, best first, capped
 *   block({ dir, brief })             { text, indexChars, topics } — the prompt block
 *   INDEX_CHARS, MAX_TOPICS, TOPIC_CHARS, INDEX_FILE, TOPICS_DIR
 */

const fs = require('fs');
const path = require('path');

const INDEX_FILE = 'MEMORY.md';
const TOPICS_DIR = 'memory';
const INDEX_CHARS = 4000;
const MAX_TOPICS = 2;
const TOPIC_CHARS = 2000;

/** The file's text, capped, or '' when it is not there or not readable. */
function readCapped(file, max) {
    try {
        const text = fs.readFileSync(file, 'utf8');
        if (!text || !text.trim()) return '';
        return text.length > max ? text.slice(0, max) : text;
    } catch { return ''; }
}

/** The index: the repository's MEMORY.md, always loaded, capped. */
function indexOf(dir) {
    if (!dir) return '';
    return readCapped(path.join(String(dir), INDEX_FILE), INDEX_CHARS);
}

/** Every topic file under the repository's memory folder. */
function topics(dir) {
    if (!dir) return [];
    let names;
    try { names = fs.readdirSync(path.join(String(dir), TOPICS_DIR)); } catch { return []; }
    const out = [];
    for (const name of names.sort()) {
        if (!name.endsWith('.md') || name.startsWith('.')) continue;
        const text = readCapped(path.join(String(dir), TOPICS_DIR, name), TOPIC_CHARS);
        if (text) out.push({ topic: name.replace(/\.md$/, ''), text });
    }
    return out;
}

/** The brief's words worth searching for: lowercased, short and common ones dropped. */
function wordsOf(query) {
    const stop = new Set(('the,a,an,and,or,to,of,in,on,for,with,from,that,this,what,when,how,are,was,were,is,it,as,at,be,by,do,does,did,you,your,into,over,under,than,then,than,not,but,all,any,can,will,just,make,fix,ship,use,add,new,old,way,our,its,their,them,they,we,my,me,i').split(','));
    return [...new Set(String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !stop.has(w)))];
}

/**
 * The topics the query points at: word overlap between the brief and the topic, most overlapping first, capped at
 * MAX_TOPICS. A topic no brief word reaches is not loaded, however short; ties break by topic name, so the choice
 * is stable for the same brief.
 */
function search(dir, query) {
    const words = wordsOf(query);
    if (!words.length) return [];
    const scored = [];
    for (const t of topics(dir)) {
        const hay = (t.topic + '\n' + t.text).toLowerCase();
        let score = 0;
        for (const w of words) if (hay.includes(w)) score++;
        if (score > 0) scored.push({ ...t, score });
    }
    scored.sort((a, b) => b.score - a.score || (a.topic < b.topic ? -1 : 1));
    return scored.slice(0, MAX_TOPICS);
}

/** The prompt block: the index always, then the topics the brief points at. Empty when there is no memory. */
function block({ dir, brief } = {}) {
    const index = indexOf(dir);
    const found = search(dir, brief);
    const parts = [];
    if (index) parts.push('# Memory (index, always loaded)\n' + index);
    for (const t of found) parts.push(`# Memory: ${t.topic}\n` + t.text);
    return {
        text: parts.join('\n\n'),
        indexChars: index.length,
        topics: found.map((t) => ({ topic: t.topic, score: t.score, chars: t.text.length })),
    };
}

module.exports = {
    INDEX_FILE, TOPICS_DIR, INDEX_CHARS, MAX_TOPICS, TOPIC_CHARS,
    indexOf, topics, search, block,
};
