'use strict';

/**
 * What place() needs besides the offers, read outside the request's placement itself:
 *
 * - the person's two rules from Codes' settings (noCloud, onlyFree);
 * - Bench's priors for the kind, cached an hour (bench-priors.js);
 * - the learned outcomes: one read of the person's rows plus the five-minute global cache (placement-outcomes.js);
 * - the person's own machine when noCloud is set (the task's fleet, read before this, tells which harnesses it runs).
 *
 *   createPlacementContext({ store, config, userSettings, outcomes, priors, now }) →
 *     forTask({ subject, task, ownMachine, onlyAgent }) → the place() context
 *     record({ person, key, kind, ok, at })            → learn() once, persisted
 *
 * No I/O here beyond those three reads; the placement itself is pure.
 */
function createPlacementContext({ store, config = {}, userSettings, outcomes, priors, harnesses = null, now = store.now } = {}) {
    async function forTask({ subject, task, ownMachine = null, onlyAgent = null } = {}) {
        const settings = await userSettings.get(subject);
        // The fleet is read only when the noCloud rule needs it: a task with the default rules adds no Bot read.
        const own = settings.no_cloud ? (typeof ownMachine === 'function' ? await ownMachine() : ownMachine) : null;
        const [scores, learned] = await Promise.all([
            priors ? priors.forTask(task) : Promise.resolve({}),
            outcomes ? outcomes.forPerson(subject) : Promise.resolve([]),
        ]);
        // Bench scores models; a Codes offer is a harness×agent, so the prior lands on the offer id optionKey() uses.
        const priorsByOfferId = {};
        if (harnesses && scores && Object.keys(scores).length) {
            for (const harness of harnesses.list()) {
                for (const agent of harnesses.agents(harness.id)) {
                    const score = agent.model ? scores[agent.model] : undefined;
                    if (score != null) priorsByOfferId[`${harness.id}:${agent.id || agent.model}`] = score;
                }
            }
        }
        return {
            person: subject,
            rules: { noCloud: !!settings.no_cloud, onlyFree: !!settings.only_free },
            priorsByOfferId,
            outcomes: learned,
            ownMachine: own,
            onlyAgent,
            now: now(),
        };
    }

    async function record({ person, key, kind, ok, at = now() }) {
        return outcomes ? outcomes.record({ person, key, kind, ok, at }) : null;
    }

    /** Persist what escalate() returned (it learned the failed try): never record that failure again. */
    async function recordEscalation(result, person) {
        return outcomes ? outcomes.recordAll(result && result.outcomes, person) : 0;
    }

    return { forTask, record, recordEscalation };
}

module.exports = { createPlacementContext };
