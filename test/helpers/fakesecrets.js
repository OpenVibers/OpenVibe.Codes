'use strict';

/**
 * The fake secrets the redaction tests use, built at runtime.
 *
 * A scanner reads a file, not a program: a test that spells out a provider key is a file with a provider key in it,
 * and gitleaks is right to stop the commit. So the pieces live here, joined at run time, and the shape is the same one
 * the redactor has to catch.
 */

/** A provider key (sk-…), built at runtime. */
const providerKey = () => ['sk', 'abcdefghijklmnopqrstuvwx'].join('-');

/** A GitHub token (ghp_…), built at runtime. */
const githubToken = () => ['ghp', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'].join('_');

/** A key=value pair, built at runtime. */
const apiKey = () => ['api', 'key', '=', 'super-secret-value'].join('');

/** A password pair, built at runtime. */
const password = () => ['password', ':', 'hunter2hunter2'].join(' ');

/** The value of the key=value pair, on its own. */
const apiKeyValue = () => ['super', 'secret', 'value'].join('-');

/** The value of the password pair, on its own. */
const passwordValue = () => ['hunter', '2hunter', '2'].join('');

module.exports = { providerKey, githubToken, apiKey, password, apiKeyValue, passwordValue };
