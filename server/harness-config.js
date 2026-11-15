'use strict';
/**
 * The `codes.harnesses` namespace (D11 owner settings; plan §AD.9 step 3, the owner on /admin/ai/setup, 2026-11-15:
 * "missing all the different agents … configuration"): which coding agents people may use, and the model each one runs
 * when nobody picks. Network's AI setup (Coding agents) reads and writes it through /internal/config, like codes.ai.
 *
 *   off       harness ids nobody can pick or run (their runs answer 422 codes.agent_off; the catalogue leaves them out,
 *             GET /api/v1/harnesses?all=1 lists them with off: true so the owner can turn them back on)
 *   defaults  { harness id: agent id }: the agent (model) a harness runs when none is named; it is listed first
 *
 * gate(base) wraps the static catalogue (server/domain/harnesses.js) so every reader (the catalogue route, the runs,
 * placement, settings) sees the owner's choice at once, without a restart. Ids the catalogue does not know are ignored.
 */
const shared = require('openvibe-shared/config');

const SERVICE = 'codes';
const NAMESPACE = 'codes.harnesses';
const ID = '^[a-z0-9][a-z0-9._-]{0,63}$';

const SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Coding agents',
    description: 'Which coding agents people can use in Codes and in the menu, and the model each runs when nobody picks one. Coding never runs on OpenVibe\'s own server: on a shared OpenVibe computer or the person\'s own.',
    type: 'object',
    additionalProperties: false,
    properties: {
        off: {
            type: 'array', title: 'Turned off', 'x-group': 'Coding agents', maxItems: 100,
            description: 'Coding agents nobody can pick or run. Their running work finishes; new work cannot start on them.',
            items: { type: 'string', pattern: ID },
        },
        defaults: {
            type: 'object', title: 'Model when nobody picks', 'x-group': 'Coding agents', maxProperties: 100,
            description: 'For each coding agent, the model it runs when the person does not choose one.',
            additionalProperties: { type: 'string', pattern: ID },
        },
    },
};
const DEFAULTS = Object.freeze({ off: [], defaults: {} });

async function create({ db, env = process.env, log = console }) {
    const store = await shared.createConfigStore({
        db, service: SERVICE, namespace: NAMESPACE, schema: SCHEMA, defaults: DEFAULTS, env, log,
        onChange: ({ namespace, keys: changed, actor: who, revision }) => {
            log.info(`[config] ${SERVICE} ${namespace} revision ${revision} by ${who && who.id ? `${who.type}:${who.id}` : 'unknown'}: ${changed.join(', ')}`);
        },
    });
    const offSet = () => new Set(Array.isArray(store.get('off')) ? store.get('off') : []);
    const defaultsOf = () => { const d = store.get('defaults'); return d && typeof d === 'object' ? d : {}; };

    /** The catalogue as the owner set it: off harnesses gone, each harness's default agent first. */
    function gate(base) {
        const ordered = (id) => {
            const agents = base.agents(id);
            const want = defaultsOf()[id];
            if (!want || !agents.some((a) => a.id === want)) return agents;
            return [...agents.filter((a) => a.id === want), ...agents.filter((a) => a.id !== want)];
        };
        const withOrder = (row) => (row ? { ...row, agents: ordered(row.id) } : null);
        return {
            list: () => { const off = offSet(); return base.list().filter((h) => !off.has(h.id)).map(withOrder); },
            get: (id) => (offSet().has(id) ? null : withOrder(base.get(id))),
            agents: (id) => (offSet().has(id) ? [] : ordered(id)),
            /** Every harness, off ones marked, for the owner's page (GET /api/v1/harnesses?all=1). */
            all: () => { const off = offSet(); const d = defaultsOf(); return base.list().map((h) => ({ ...withOrder(h), off: off.has(h.id), default_agent: d[h.id] && base.agents(h.id).some((a) => a.id === d[h.id]) ? d[h.id] : ((base.agents(h.id)[0] || {}).id || null) })); },
            isOff: (id) => offSet().has(id),
            known: (id) => !!base.get(id),
        };
    }
    return { store, gate, SCHEMA };
}

module.exports = { create, SCHEMA, NAMESPACE };
