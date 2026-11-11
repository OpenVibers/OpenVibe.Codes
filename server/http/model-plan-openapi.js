'use strict';

const plan = { $ref: 'https://openvibe.network/contracts/codes/model-plan.v1.json' };
const project = { name: 'project', in: 'query', required: false, schema: { type: 'string' }, description: 'Project id; omit for the account default.' };
const auth = [{ bearerAuth: [] }];
const json = (description) => ({ description, content: { 'application/json': { schema: { type: 'object' } } } });

function modelPlanPaths() {
    return {
        '/api/v1/model-plans': {
            get: { operationId: 'codes.modelPlans.get', summary: 'Read account and project model plans', parameters: [project], security: auth, responses: { 200: json('Account, project and effective plan.'), 401: json('Sign in or send a person token.') } },
            put: { operationId: 'codes.modelPlans.put', summary: 'Save an account or project model plan', parameters: [project], security: auth, requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['plan'], properties: { plan }, additionalProperties: false } } } }, responses: { 200: json('Saved plan, resolved models, fallback reasons and registry prices.'), 422: json('Invalid plan or model.'), 503: json('AI model registry unavailable.') } },
        },
        '/api/v1/model-plans/presets': {
            get: { operationId: 'codes.modelPlans.presets', summary: 'Copyable Fast, Balanced, Deep and Council plans', responses: { 200: json('Named plans.') } },
        },
    };
}

function extendTaskCreate(paths) {
    const post = paths['/api/v1/tasks']?.post;
    const content = post?.requestBody?.content?.['application/json'];
    if (!content?.schema) return;
    const original = content.schema;
    content.schema = { oneOf: [original, {
        type: 'object', required: ['repo', 'prompt'],
        properties: {
            repo: { type: 'string' }, prompt: { type: 'string' },
            plan, preset: { type: 'string', enum: ['Fast', 'Balanced', 'Deep', 'Council'] },
        },
        oneOf: [{ required: ['plan'] }, { required: ['preset'] }],
        additionalProperties: true,
    }] };
    post.description = `${post.description || ''}\n\nA task may provide a model plan or one of the copyable presets. The task override takes precedence over repository, project and account plans.`;
}

module.exports = { modelPlanPaths, extendTaskCreate };
