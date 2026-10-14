'use strict';
/**
 * Account export and deletion → Codes (ADR-033; openvibe-sdk/account-data). What Codes holds about a person is the
 * coding tasks they started on their own machine (run_tasks, plan T16): what they asked, the Run job and its result.
 * The export carries them whole; a deletion erases them. The Run jobs themselves are OpenVibe.Run's records (usage
 * billed to the project) and are Run's to answer for.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const TABLES = [
    {
        table: 'run_tasks', subject: 'subject', file: 'run-tasks.json', order: 'created_at',
        columns: ['id', 'project_id', 'job_id', 'repo', 'ref', 'prompt', 'agent', 'push', 'pull_request', 'state', 'result', 'error', 'created_at', 'updated_at'],
    },
];

function create({ db, log = console }) {
    return createAccountData({ db, service: 'codes', tables: TABLES, log });
}

module.exports = { create, TABLES, TOPICS };
