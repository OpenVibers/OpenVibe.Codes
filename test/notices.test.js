'use strict';

/**
 * Notices (Codes C9c): "done" and "needs you" reach the person through Network's notifications, once per task and
 * state, and the two Settings switches (notify_done, notify_needs) are honoured. The Action Center is not a push: it
 * reads the tasks themselves, so this only covers the notification.
 */
const assert = require('assert');
const { check, done } = require('./helpers/boot');
const { createStore } = require('../server/db');
const { createNotices } = require('../server/domain/notices');
const { createUserSettings } = require('../server/domain/user-settings');
const { testDb } = require('./helpers/db');

const SUBJECT = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2AB';

(async () => {
    const testdb = await testDb();
    const store = createStore(testdb.db);
    const settings = createUserSettings({ store });

    try {
        await check('done and needs reach the person through Network, with a way back to the task', async () => {
            const sent = [];
            const notices = createNotices({ store, config: { baseUrl: 'https://openvibe.codes' }, userSettings: settings, notify: { async push(body) { sent.push(body); return { sent: true }; } } });
            const task = { id: 'tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2AB', subject: SUBJECT };
            assert.equal((await notices.done(task, 'It added the endpoint and the tests.')).sent, true);
            assert.equal((await notices.needs(task, 'It stopped at its budget.')).sent, true);
            assert.equal(sent.length, 2);
            assert.equal(sent[0].title, 'Your task is done');
            assert.equal(sent[0].url, `https://openvibe.codes/tasks/${task.id}`);
            assert.equal(sent[0].category, 'codes');
            assert.equal(sent[1].title, 'Your task needs you');
            assert.equal(sent[1].priority, 'high');
            assert.match(sent[1].message, /budget/);
        });

        await check('one notice per task and state: a redelivered event does not tell the person twice', async () => {
            const sent = [];
            const notices = createNotices({ store, config: { baseUrl: 'https://openvibe.codes' }, userSettings: settings, notify: { async push(body) { sent.push(body); return { sent: true }; } } });
            const task = { id: 'tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2AC', subject: SUBJECT };
            assert.equal((await notices.done(task)).sent, true);
            const again = await notices.done(task);
            assert.equal(again.sent, false);
            assert.equal(again.reason, 'already');
            assert.equal(sent.length, 1, 'the second call sent nothing');
        });

        await check('a switch that is off is not an error, and the notice is not retried', async () => {
            await settings.save(SUBJECT, { notify_done: false, notify_needs: false });
            const sent = [];
            const notices = createNotices({ store, config: { baseUrl: 'https://openvibe.codes' }, userSettings: settings, notify: { async push(body) { sent.push(body); return { sent: true }; } } });
            const task = { id: 'tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2AD', subject: SUBJECT };
            assert.equal((await notices.done(task, 'finished')).reason, 'switched_off');
            assert.equal((await notices.needs(task, 'needs a person')).reason, 'switched_off');
            assert.equal(sent.length, 0, 'nothing was pushed');
        });

        await check('a Network that does not answer does not stop the task, and is said', async () => {
            await settings.save(SUBJECT, { notify_done: true, notify_needs: true });
            const notices = createNotices({ store, config: { baseUrl: 'https://openvibe.codes' }, userSettings: settings, log: { warn() {} }, notify: { async push() { throw new Error('network down'); } } });
            const task = { id: 'tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2AE', subject: SUBJECT };
            const out = await notices.needs(task, 'it could not start');
            assert.equal(out.sent, false);
            assert.equal(out.reason, 'network_error');
        });

        await check('a task with no person, or no task, sends nothing', async () => {
            const notices = createNotices({ store, config: {}, userSettings: settings, notify: { async push() { throw new Error('should not be called'); } } });
            assert.equal((await notices.done(null)).reason, 'bad_input');
            assert.equal((await notices.done({ id: 'not-a-task', subject: SUBJECT })).reason, 'bad_input');
            assert.equal((await notices.done({ id: 'tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2AF' })).reason, 'no_subject');
            assert.equal((await notices.send({ id: 'tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2AF', subject: SUBJECT }, 'nope')).reason, 'bad_input');
        });
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    } finally {
        await testdb.close();
    }
    done();
})();
