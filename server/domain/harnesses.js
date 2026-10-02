'use strict';

/** Static harness catalog. Replace the file reader when offer ownership is settled. */
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');

const DEFAULT_CATALOG = path.join(__dirname, '..', 'data', 'harness-offers.json');

function invalid(detail) {
    const error = new Error(`invalid harness catalog: ${detail}`);
    error.code = 'harness.invalid';
    return error;
}

function createHarnesses({ catalogPath = DEFAULT_CATALOG } = {}) {
    let rows;
    try {
        rows = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    } catch (error) {
        throw invalid(error.message);
    }
    if (!Array.isArray(rows)) throw invalid('expected an array of offers');

    const byId = new Map();
    const ids = new Set();
    for (const [index, row] of rows.entries()) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw invalid(`row ${index} is not an offer`);
        const { agents, ...offer } = row;
        const harnessCheck = contracts.validate('platform.harness-offer@1', offer);
        if (!harnessCheck.valid) throw invalid(`row ${index} harness offer: ${JSON.stringify(harnessCheck.errors)}`);
        if (ids.has(offer.id)) throw invalid(`duplicate id ${offer.id}`);
        ids.add(offer.id);
        if (!Array.isArray(agents)) throw invalid(`row ${index} needs agents[]`);
        for (const [agentIndex, agent] of agents.entries()) {
            const agentCheck = contracts.validate('platform.agent-offer@1', agent);
            if (!agentCheck.valid) throw invalid(`row ${index} agent ${agentIndex}: ${JSON.stringify(agentCheck.errors)}`);
            if (ids.has(agent.id)) throw invalid(`duplicate id ${agent.id}`);
            if (agent.harness !== offer.id) throw invalid(`agent ${agent.id} refers to another harness`);
            ids.add(agent.id);
        }
        byId.set(offer.id, row);
    }

    const get = (id) => byId.get(id) || null;
    const list = () => [...byId.values()];
    const agents = (id) => get(id)?.agents || [];
    return { list, get, agents };
}

module.exports = { createHarnesses };
