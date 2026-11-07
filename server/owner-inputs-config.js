'use strict';
/**
 * Codes' owner inputs (the owner-setup design of 2026-11-07): the outside accounts and keys only the owner can give,
 * as two namespaces on openvibe-shared/config that the admin panel's Setup tab lists.
 *
 *   codes.accounts     the sign-in apps and the GitHub reader:
 *                        forge.client_id / forge.client_secret   the OpenVibe Git (Forgejo) OAuth app that lets a
 *                                                                 person link their OpenVibe Git account (read by
 *                                                                 server/domain/forge.js; CODES_FORGE_CLIENT_* fallback)
 *                        github.client_id / github.client_secret the GitHub OAuth app for a GitHub sign-in in Codes.
 *                                                                 Nothing reads it yet: Optional, waiting for that sign-in
 *                        github.token                            a read-only GitHub token that raises GitHub's limits
 *                                                                 for the repository search and the CI state (read by
 *                                                                 server/domain/github.js and ship.js; CODES_GITHUB_TOKEN
 *                                                                 fallback)
 *   codes.publishing   the store and registry tokens release jobs need (Chrome Web Store, Firefox add-ons, npm, code
 *                      signing). No release job reads them yet, so every one is Optional and says what it unlocks.
 *
 * Secrets are write-only through /internal/config/:namespace/secrets/:key, sealed with the service's KEK and shown
 * only as their last four characters. No x-env pin: the value entered in the panel wins, and the environment stays
 * the fallback, read at use time through value() below.
 */
const shared = require('openvibe-shared/config');

const SERVICE = 'codes';
const ACCOUNTS = 'codes.accounts';
const PUBLISHING = 'codes.publishing';

const ACCOUNTS_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Sign-in apps and GitHub',
    description: 'The outside apps people sign in to from Codes, and the GitHub token Codes reads public repositories with. Change these when you register an app, rotate its secret or replace the token.',
    type: 'object',
    additionalProperties: false,
    properties: {
        'forge.client_id': {
            type: 'string', minLength: 8, maxLength: 200, title: 'OpenVibe Git app: client ID', 'x-group': 'OpenVibe Git', 'x-example': '3f2a9c1e-…',
            description: 'The client ID of the OAuth2 application registered on OpenVibe Git for Codes. With its secret and the seal key it lets people link their OpenVibe Git account; without it linking stays closed.',
            'x-owner-input': {
                group: 'sign-in-apps',
                unlocks: 'Lets people link their OpenVibe Git account in Codes, so tasks can make repositories and push as them. Without it the Link button says linking is not open yet.',
                get_it_at: 'https://git.openvibe.codes/user/settings/applications',
                get_it_how: 'Signed in as the owner, create an OAuth2 application named Codes with the redirect URI https://openvibe.codes/git/callback, and copy its Client ID.',
                test: false,
            },
            'x-required-for': 'Linking an OpenVibe Git account',
        },
        'forge.client_secret': {
            type: 'string', minLength: 8, maxLength: 512, title: 'OpenVibe Git app: client secret', 'x-group': 'OpenVibe Git',
            description: 'The secret of the same OpenVibe Git application, shown once when it is created. Codes sends it only to OpenVibe Git, when a person links their account; it is never shown again here.',
            'x-owner-input': {
                group: 'sign-in-apps',
                unlocks: 'Completes the OpenVibe Git app: with the client ID it lets people link their OpenVibe Git account in Codes.',
                get_it_at: 'https://git.openvibe.codes/user/settings/applications',
                get_it_how: 'Copy the Client Secret shown when the application is created (or regenerate it there).',
                test: false,
            },
            'x-required-for': 'Linking an OpenVibe Git account',
        },
        'github.client_id': {
            type: 'string', minLength: 8, maxLength: 200, title: 'GitHub app: client ID', 'x-group': 'GitHub', 'x-example': 'Ov23li…',
            description: 'The client ID of a GitHub OAuth app for signing in to Codes with GitHub. Codes does not offer that sign-in yet; the app waits here until it does, and nothing uses it before then.',
            'x-owner-input': {
                group: 'sign-in-apps',
                unlocks: 'Will let people connect their GitHub account in Codes, so tasks can read their private repositories and open pull requests as them. Optional: Codes has no GitHub sign-in yet.',
                get_it_at: 'https://github.com/organizations/OpenVibers/settings/applications/new',
                get_it_how: 'Register a new OAuth app for the OpenVibers organisation with the homepage https://openvibe.codes and the callback https://openvibe.codes/auth/github/callback.',
                test: false,
            },
        },
        'github.client_secret': {
            type: 'string', minLength: 8, maxLength: 512, title: 'GitHub app: client secret', 'x-group': 'GitHub',
            description: 'The secret of the same GitHub OAuth app. The Test button checks the ID and secret with GitHub without signing anyone in; nothing else uses it until Codes has a GitHub sign-in.',
            'x-owner-input': {
                group: 'sign-in-apps',
                unlocks: 'Completes the GitHub app for a future GitHub sign-in in Codes. Optional: nothing uses it yet.',
                get_it_at: 'https://github.com/organizations/OpenVibers/settings/applications',
                get_it_how: 'Open the app, Generate a new client secret, and copy it at once (GitHub shows it only once).',
                test: true,
            },
        },
        'github.token': {
            type: 'string', minLength: 20, maxLength: 512, title: 'GitHub token (read only)', 'x-group': 'GitHub', 'x-example': 'github_pat_…',
            description: 'A read-only GitHub token Codes uses for the repository search and a pull request\'s CI state. Without it GitHub allows about 60 requests an hour, so searches start failing on a busy day.',
            'x-owner-input': {
                group: 'data-sources',
                unlocks: 'Raises GitHub\'s limit from 60 to 5,000 requests an hour for Codes\' repository search and pull-request checks. Optional: without it they still work on a quiet day.',
                get_it_at: 'https://github.com/settings/personal-access-tokens/new',
                get_it_how: 'Create a fine-grained token with Public repositories (read-only) access and no other permission.',
                test: true,
            },
        },
    },
};

const publishingField = (title, description, unlocks, getItAt, getItHow, extra = {}) => ({
    type: 'string', minLength: 8, maxLength: 16384, title, 'x-group': extra.group || 'Release jobs', description,
    ...(extra.example ? { 'x-example': extra.example } : {}),
    'x-owner-input': { group: 'design-publishing', unlocks, get_it_at: getItAt, get_it_how: getItHow, test: Boolean(extra.test) },
});

const PUBLISHING_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Publishing and signing',
    description: 'The store and registry accounts a release job would publish OpenVibe\'s extensions, packages and apps with. No release job uses them yet: they are kept here, locked, so publishing can be switched on without asking you again.',
    type: 'object',
    additionalProperties: false,
    properties: {
        'chrome.client_id': publishingField('Chrome Web Store: OAuth client ID',
            'The client ID of a Google Cloud OAuth client that may use the Chrome Web Store API. With the secret and refresh token below a release job could upload a new extension version.',
            'Will let a release job publish OpenVibe\'s browser extensions to the Chrome Web Store. Optional: extensions are uploaded by hand until a job uses it.',
            'https://console.cloud.google.com/apis/credentials',
            'In a project with the Chrome Web Store API on, create an OAuth client ID of type Desktop app and copy its Client ID.', { group: 'Chrome Web Store', example: '1234-abc.apps.googleusercontent.com' }),
        'chrome.client_secret': publishingField('Chrome Web Store: OAuth client secret',
            'The secret of the same Google OAuth client. It is only ever sent to Google, to turn the refresh token into a short-lived upload token, and is never shown again here.',
            'Completes the Chrome Web Store access for a future release job. Optional: nothing uses it yet.',
            'https://console.cloud.google.com/apis/credentials',
            'Open the OAuth client and copy its Client secret.', { group: 'Chrome Web Store' }),
        'chrome.refresh_token': publishingField('Chrome Web Store: refresh token',
            'A long-lived Google refresh token for the account that owns the extensions, with the chromewebstore scope. It lets a release job upload without anyone signing in each time.',
            'Completes the Chrome Web Store access for a future release job. Optional: nothing uses it yet.',
            'https://developer.chrome.com/docs/webstore/using-api',
            'Follow "Get the refresh token" with the client above, signed in as the account that owns the extensions.', { group: 'Chrome Web Store' }),
        'firefox.jwt_issuer': publishingField('Firefox add-ons: JWT issuer',
            'The JWT issuer (user:12345:67) of an addons.mozilla.org API key. With its secret a release job could sign and submit a new add-on version.',
            'Will let a release job publish OpenVibe\'s Firefox add-ons to addons.mozilla.org. Optional: add-ons are uploaded by hand until a job uses it.',
            'https://addons.mozilla.org/developers/addon/api/key/',
            'Generate new credentials and copy the JWT issuer.', { group: 'Firefox add-ons', example: 'user:12345:67' }),
        'firefox.jwt_secret': publishingField('Firefox add-ons: JWT secret',
            'The JWT secret of the same addons.mozilla.org API key. It signs each upload request and is never sent anywhere; it is never shown again here.',
            'Completes the Firefox add-ons access for a future release job. Optional: nothing uses it yet.',
            'https://addons.mozilla.org/developers/addon/api/key/',
            'Copy the JWT secret shown with the issuer (it is shown only once).', { group: 'Firefox add-ons' }),
        'npm.token': publishingField('npm publish token',
            'An npm granular access token that may publish OpenVibe\'s packages. A release job would publish a tagged library version with it instead of someone typing npm publish.',
            'Will let a release job publish OpenVibe\'s libraries to npm. Optional: libraries are installed from GitHub tags today and nothing publishes to npm yet.',
            'https://www.npmjs.com/settings/~/tokens/granular-access-tokens/new',
            'Create a granular access token with Read and write on the OpenVibe packages only, and an expiry you will remember to renew.', { group: 'npm', example: 'npm_…', test: true }),
        'signing.windows_certificate': publishingField('Windows code-signing certificate (.pfx, base64)',
            'The Windows code-signing certificate and its private key, as a .pfx file in base64. A release job would sign the Windows downloads with it so Windows stops warning people about an unknown publisher.',
            'Will let a release job sign OpenVibe\'s Windows apps, so SmartScreen trusts them. Optional: the downloads are unsigned (with SHA256SUMS) until a job uses it.',
            'https://learn.microsoft.com/windows/win32/seccrypto/cryptography-tools',
            'Buy an OV or EV code-signing certificate from a certificate authority, export it with its key as .pfx, and paste the file as base64.', { group: 'Code signing' }),
        'signing.windows_password': publishingField('Windows code-signing certificate password',
            'The password that opens the .pfx above. It is only used on the release machine to sign files and is never shown again here.',
            'Completes the Windows code signing for a future release job. Optional: nothing uses it yet.',
            'https://learn.microsoft.com/windows/win32/seccrypto/cryptography-tools',
            'The password you chose when exporting the .pfx.', { group: 'Code signing' }),
        'signing.apple_certificate': publishingField('Apple Developer ID certificate (.p12, base64)',
            'The Developer ID Application certificate and its key, as a .p12 file in base64. A release job would sign and notarize the macOS downloads with it so macOS opens them without a warning.',
            'Will let a release job sign OpenVibe\'s macOS apps with a Developer ID. Optional: the downloads are unsigned until a job uses it.',
            'https://developer.apple.com/account/resources/certificates/list',
            'With an Apple Developer membership, create a Developer ID Application certificate, export it with its key from Keychain as .p12, and paste it as base64.', { group: 'Code signing' }),
        'signing.apple_password': publishingField('Apple Developer ID certificate password',
            'The password that opens the .p12 above. It is only used on the release machine to sign files and is never shown again here.',
            'Completes the macOS code signing for a future release job. Optional: nothing uses it yet.',
            'https://developer.apple.com/account/resources/certificates/list',
            'The password you chose when exporting the .p12 from Keychain.', { group: 'Code signing' }),
    },
};

const ACCOUNTS_SECRETS = new Set(['forge.client_secret', 'github.client_secret', 'github.token']);
const classifyAccounts = (key) => (ACCOUNTS_SECRETS.has(key) ? 'secret' : 'internal');
const classifyPublishing = (key) => (key === 'chrome.client_id' || key === 'firefox.jwt_issuer' ? 'internal' : 'secret');

/** The environment variable each key falls back to (only the keys Codes reads today have one). */
const ENV_FALLBACK = Object.freeze({
    'forge.client_id': 'CODES_FORGE_CLIENT_ID',
    'forge.client_secret': 'CODES_FORGE_CLIENT_SECRET',
    'github.token': 'CODES_GITHUB_TOKEN',
});

async function create({ db, env = process.env, log = console }) {
    const onChange = ({ namespace, keys, actor: who, revision }) => {
        (log.info || log.log).call(log, `[config] ${SERVICE} ${namespace} revision ${revision} by ${who && who.id ? `${who.type}:${who.id}` : 'unknown'}: ${keys.join(', ')}`);
    };
    const accounts = await shared.createConfigStore({ db, service: SERVICE, namespace: ACCOUNTS, schema: ACCOUNTS_SCHEMA, env, classify: classifyAccounts, log, onChange });
    const publishing = await shared.createConfigStore({ db, service: SERVICE, namespace: PUBLISHING, schema: PUBLISHING_SCHEMA, env, classify: classifyPublishing, log, onChange });
    if (env.OV_CONFIG_KEKS) {
        for (const s of [accounts, publishing]) {
            try { await s.reseal(); } catch (err) { log.warn(`[config] ${s.namespace}: reseal failed: ${(err && err.message) || err}`); }
        }
    }
    const storeOf = (namespace) => (namespace === ACCOUNTS ? accounts : namespace === PUBLISHING ? publishing : null);
    /** A key's value at use time: { value, source: vault | env | null, env }. The panel's value wins. */
    function value(namespace, key) {
        const s = storeOf(namespace);
        const own = s ? s.get(key) : undefined;
        const name = namespace === ACCOUNTS ? ENV_FALLBACK[key] || null : null;
        if (typeof own === 'string' && own) return { value: own, source: 'vault', env: name };
        const fallback = name ? String(env[name] || '').trim() : '';
        return { value: fallback, source: fallback ? 'env' : null, env: name };
    }
    return { accounts, publishing, stores: [accounts, publishing], value };
}

module.exports = { create, ACCOUNTS, PUBLISHING, ACCOUNTS_SCHEMA, PUBLISHING_SCHEMA, ENV_FALLBACK };
