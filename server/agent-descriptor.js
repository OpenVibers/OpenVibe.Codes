'use strict';
// What openvibe.codes tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this site really serves; /start is the harness's own documentation and the JSON API
// is the public catalog and router, so both are named. A run's page is a person's run, never advertised here.
module.exports = {
    id: 'codes',
    name: 'OpenVibe.Codes',
    purpose: 'The open coding-agent harness: one router over Claude Code, Codex, OpenCode, Command Code, Aider, the DeepSeek API and your own models, with hand-offs between agents, and the way to improve OpenVibe itself.',
    home: 'https://openvibe.codes',
    site: 'openvibe.codes',
    api: '/api/v1',
    docs: '/start',
    policy: {
        auth: ['none', 'Network OIDC'],
        rateLimit: '300 page requests a minute per address; 60 public API requests a minute',
    },
};
