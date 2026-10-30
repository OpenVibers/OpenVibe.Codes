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
 *   engine.adapters    every harness Codes can run, with the portal's argv and environment
 *   engine.jobrunner   one attempt of one harness, the way the portal runs one
 *   engine.prompt      the prompt every job gets (the rules, the lessons, the digest, the brief)
 *   engine.repomap     the repo digest a job gets instead of a directory tree
 *   engine.joblines    the lines a task's page shows while it runs
 *   engine.logins      what this machine has: each CLI, signed in or not, and its limit windows
 *   engine.redact      the secrets that never reach an event stream
 *   engine.proof       the proof of a finished attempt: its tests, its pages, its diff, and a second opinion
 *   engine.review      the second opinion itself: a model of another family, through OpenVibe.AI
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
const adapters = require('./adapters');
const jobrunner = require('./jobrunner');
const prompt = require('./prompt');
const repomap = require('./repomap');
const joblines = require('./joblines');
const logins = require('./logins');
const redact = require('./redact');
const proof = require('./proof');
const review = require('./review');

module.exports = {
    router,
    chain,
    budget,
    transcript,
    effort,
    scope,
    runerror,
    adapters,
    jobrunner,
    prompt,
    repomap,
    joblines,
    logins,
    redact,
    proof,
    review,
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
    // C5: the job runner and the harnesses it can run.
    runAttempt: jobrunner.runAttempt,
    adapterFor: adapters.adapterFor,
    assemblePrompt: prompt.assemble,
    jobLines: joblines.lines,
    probeLogins: logins.probe,
    scrub: redact.scrub,
};
