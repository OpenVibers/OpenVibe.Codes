#!/usr/bin/env node
'use strict';
/**
 * Refreshes harness/acp-agents.json from the public ACP registry: the coding agents Codes offers through its ACP
 * adapter (harness/adapters/acp.js), each pinned to the exact version the registry names, launched with npx or uvx
 * only (a binary is not downloaded and run). A reviewed list: an agent is added here by hand, never by the registry.
 *
 *   node scripts/acp-registry.js [registry.json]     (default: fetch https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)
 */
const fs = require('fs');
const path = require('path');

const REGISTRY = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
// The registry's id → the harness id Codes uses (Codes' own adapters keep their ids: claude-code, codex, minimax-code).
const WANTED = {
    'claude-acp': 'claude-acp',
    'codex-acp': 'codex-acp',
    gemini: 'gemini-cli',
    'qwen-code': 'qwen-code',
    'kimi-code': 'kimi-code',
    'grok-build': 'grok-build',
    'github-copilot-cli': 'copilot-cli',
    cline: 'cline',
    kilo: 'kilo',
    deepagents: 'deepagents',
    auggie: 'auggie',
    qoder: 'qoder',
    'codebuddy-code': 'codebuddy-code',
    'glm-acp-agent': 'glm-acp',
    'pi-acp': 'pi',
    'factory-droid': 'droid',
};

(async () => {
    const src = process.argv[2];
    const registry = src ? JSON.parse(fs.readFileSync(src, 'utf8')) : await (await fetch(REGISTRY)).json();
    const all = Array.isArray(registry.agents) ? registry.agents : [];
    const agents = [];
    for (const [rid, id] of Object.entries(WANTED)) {
        const a = all.find((x) => x.id === rid);
        if (!a) { console.error(`not in the registry now: ${rid}`); continue; }
        const d = a.distribution || {};
        const launch = d.npx ? { npx: { package: d.npx.package, args: d.npx.args || [], ...(d.npx.env ? { env: d.npx.env } : {}) } }
            : d.uvx ? { uvx: { package: d.uvx.package, args: d.uvx.args || [], ...(d.uvx.env ? { env: d.uvx.env } : {}) } } : null;
        if (!launch) { console.error(`${rid} ships only a binary: left out`); continue; }
        agents.push({ id, registry_id: rid, name: a.name, version: a.version, description: String(a.description || '').slice(0, 200),
            repository: a.repository || null, license: a.license || null, distribution: launch });
    }
    const out = { source: REGISTRY, read_at: new Date().toISOString().slice(0, 10), agents };
    fs.writeFileSync(path.join(__dirname, '..', 'harness', 'acp-agents.json'), `${JSON.stringify(out, null, 2)}\n`);
    console.log(`${agents.length} agents written`);
})().catch((e) => { console.error(e); process.exit(1); });
