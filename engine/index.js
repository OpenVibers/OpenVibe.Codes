'use strict';

/**
 * The agent engine: the pieces of the private agent portal that Codes, the CLI and the hosted runner all share.
 *
 *   engine.router      what kind of task is this, and which runner may take it
 *   engine.chain       what each attempt did, why it stopped, and what happens next (pure)
 *   engine.budget      how far one task may go, and the wrap-up turn that lands the work
 *   engine.transcript  one event shape for every harness's log
 *   engine.effort      the reasoning level a harness accepts, and the models a provider refuses
 *   engine.scope       one systemd scope per job, so nothing is left behind
 *   engine.runerror    what a failed run really said
 *
 * The modules do not depend on each other in a cycle, and none of them reads the portal's log folder.
 */

const router = require('./router');
const chain = require('./chain');
const budget = require('./budget');
const transcript = require('./transcript');
const effort = require('./effort');
const scope = require('./scope');
const runerror = require('./runerror');

module.exports = {
    router,
    chain,
    budget,
    transcript,
    effort,
    scope,
    runerror,
    // The names a caller usually wants, in one place.
    classify: router.classify,
    pick: router.pick,
    outcome: chain.outcome,
    nextStep: chain.nextStep,
    evaluate: budget.evaluate,
    limitsFor: budget.limitsFor,
    parse: transcript.parse,
    parseText: transcript.parseText,
    fitEffort: effort.fitEffort,
    pickModel: effort.pickModel,
};
