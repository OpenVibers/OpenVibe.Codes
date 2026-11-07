'use strict';
/**
 * What the chat plays sandbox is made of: the bubblewrap command line (sandbox/session.js runs it). Everything the
 * sandbox can see is named here, and nothing else of the host is there.
 *
 *   namespaces   user, pid, network, ipc, uts and cgroup of its own; no nested user namespace (--disable-userns); the
 *                network namespace has only its own loopback: no route anywhere, the host's loopback included
 *   identity     uid/gid 1000 "agent" in a passwd of its own, hostname "sandbox"; every capability dropped, no new
 *                privileges, a new session (no terminal to inject keys into), killed with the worker (--die-with-parent)
 *   environment  cleared (--clearenv) and set from an allowlist: PATH, HOME, the proxy, a few locale and terminal ones
 *   files        read-only: /usr (with /usr/local hidden), the /bin and /lib links, a short list of /etc entries a
 *                program needs (certificates, fonts, the linker cache, editor and shell defaults), Node, the browser and
 *                the supervisor (one file). Written by the worker for this sandbox: passwd, group, hosts, hostname,
 *                resolv.conf, nsswitch.conf. Never /home, /root, /etc as a whole, /var, /run, /opt, /srv, /mnt, /media,
 *                /sys or any device but bwrap's minimal /dev
 *   writable     size-limited tmpfs only: /workspace, /home/agent, /tmp and /dev/shm. They die with the sandbox: that is
 *                the wipe. The root itself is read-only (--remount-ro /)
 *   egress       /run/ov/net, read-only: the directory of the worker's egress proxy socket (sandbox/egress-proxy.js)
 *   seccomp      sandbox/seccomp.js, when the architecture has a filter
 */
const fs = require('fs');
const path = require('path');

const UID = 1000;
const GID = 1000;
const HOSTNAME = 'sandbox';
const HOME = '/home/agent';
const WORKSPACE = '/workspace';
const PROXY_PORT = 3128;
const NET_DIR = '/run/ov/net';
const SUPERVISOR = '/opt/ov/supervisor.js';

// The /etc entries a program needs and that hold nothing of the host's: certificates, fonts, the dynamic linker's
// cache, editors' and shells' defaults. (/etc/ssl/private, ssh, passwd, shadow, the services' env files: never.)
const ETC_READ_ONLY = [
    'ssl/certs', 'ssl/openssl.cnf', 'ca-certificates', 'ca-certificates.conf', 'pki/tls/certs', 'pki/ca-trust/extracted',
    'fonts', 'ld.so.cache', 'ld.so.conf', 'ld.so.conf.d', 'localtime', 'timezone', 'alternatives', 'mime.types', 'magic',
    'vim', 'vimrc', 'nanorc', 'bash.bashrc', 'inputrc', 'terminfo', 'protocols', 'services',
];
// The /usr-merged links (or directories on an older layout).
const ROOT_LINKS = ['bin', 'sbin', 'lib', 'lib32', 'lib64', 'libx32'];

/** The files the worker writes for one sandbox (its own user list, host names and no DNS). */
function etcFiles({ shell = '/bin/sh' } = {}) {
    return {
        passwd: `agent:x:${UID}:${GID}:agent:${HOME}:${shell}\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n`,
        group: `agent:x:${GID}:\nnogroup:x:65534:\n`,
        hosts: `127.0.0.1\tlocalhost ${HOSTNAME}\n::1\tlocalhost ip6-localhost ip6-loopback\n`,
        hostname: `${HOSTNAME}\n`,
        // No DNS inside: names are resolved by the egress proxy, after which the guard checks the answer.
        'resolv.conf': '# No DNS in the sandbox: the egress proxy resolves names (http_proxy).\n',
        'nsswitch.conf': 'passwd: files\ngroup: files\nshadow: files\nhosts: files\nnetworks: files\nprotocols: files\nservices: files\n',
    };
}

/** The sandbox's whole environment: nothing of the worker's. */
function sandboxEnv({ nodeBin = null, browserExe = null, shell = '/bin/sh' } = {}) {
    const proxy = `http://127.0.0.1:${PROXY_PORT}`;
    return {
        PATH: [nodeBin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean).join(':'),
        HOME, USER: 'agent', LOGNAME: 'agent', SHELL: shell, LANG: 'C.UTF-8', TERM: 'xterm-256color', TMPDIR: '/tmp',
        http_proxy: proxy, https_proxy: proxy, HTTP_PROXY: proxy, HTTPS_PROXY: proxy,
        no_proxy: 'localhost,127.0.0.1,::1', NO_PROXY: 'localhost,127.0.0.1,::1',
        npm_config_cache: `${HOME}/.npm`,
        OV_SANDBOX: '1', OV_SANDBOX_PROXY_PORT: String(PROXY_PORT), OV_SANDBOX_EGRESS_SOCKET: `${NET_DIR}/egress.sock`,
        OV_SANDBOX_WORKSPACE: WORKSPACE,
        ...(browserExe ? { OV_SANDBOX_BROWSER: browserExe } : {}),
    };
}

const lstat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };

/**
 * The bwrap arguments for one sandbox.
 *   spec: { rootfs, sessionEtc, netDir, supervisorPath, nodePath, browserPath, diskMb, shmMb, seccompFd,
 *           disableUserns, hideUsrLocal }
 * → { args, env, inside: { node, browser } }
 */
function buildArgs(spec) {
    const rootfs = spec.rootfs || '/';
    const at = (p) => path.join(rootfs, p);
    const disk = Math.max(1, Math.round(Number(spec.diskMb))) * 1024 * 1024;
    const shm = Math.max(1, Math.round(Number(spec.shmMb || 64))) * 1024 * 1024;
    const args = [
        '--unshare-user', '--unshare-ipc', '--unshare-pid', '--unshare-net', '--unshare-uts', '--unshare-cgroup',
        ...(spec.disableUserns !== false ? ['--disable-userns'] : []),
        '--uid', String(UID), '--gid', String(GID), '--hostname', HOSTNAME,
        '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv',
    ];

    // Node and the browser: from /usr as they are, or their own directory bound at /opt/node and /opt/browser.
    const node = fs.realpathSync(spec.nodePath || process.execPath);
    let nodeInside = node;
    let nodeBin = null;
    const binds = [];
    if (!node.startsWith('/usr/')) {
        const prefix = path.dirname(path.dirname(node));
        binds.push(['--ro-bind', prefix, '/opt/node']);
        nodeInside = path.join('/opt/node', path.relative(prefix, node));
        nodeBin = path.dirname(nodeInside);
    }
    let browserInside = null;
    if (spec.browserPath) {
        const exe = fs.realpathSync(spec.browserPath);
        binds.push(['--ro-bind', path.dirname(exe), '/opt/browser']);
        browserInside = path.join('/opt/browser', path.basename(exe));
    }
    const shell = lstat(at('bin/bash')) || lstat(at('usr/bin/bash')) ? '/bin/bash' : '/bin/sh';
    const env = sandboxEnv({ nodeBin, browserExe: browserInside, shell });
    for (const [k, v] of Object.entries(env)) args.push('--setenv', k, v);

    args.push('--ro-bind', at('usr'), '/usr');
    if (spec.hideUsrLocal !== false && lstat(at('usr/local'))) args.push('--tmpfs', '/usr/local', '--remount-ro', '/usr/local');
    for (const name of ROOT_LINKS) {
        const st = lstat(at(name));
        if (!st) continue;
        if (st.isSymbolicLink()) args.push('--symlink', fs.readlinkSync(at(name)), `/${name}`);
        else if (st.isDirectory()) args.push('--ro-bind', at(name), `/${name}`);
    }
    args.push('--dir', '/etc');
    for (const name of ETC_READ_ONLY) if (lstat(at(`etc/${name}`))) args.push('--ro-bind', at(`etc/${name}`), `/etc/${name}`);
    for (const name of Object.keys(etcFiles())) args.push('--ro-bind', path.join(spec.sessionEtc, name), `/etc/${name}`);

    args.push('--proc', '/proc', '--dev', '/dev');
    args.push('--perms', '1777', '--size', String(shm), '--tmpfs', '/dev/shm');
    args.push('--perms', '1777', '--size', String(disk), '--tmpfs', '/tmp');
    args.push('--dir', '/home', '--perms', '0700', '--size', String(disk), '--tmpfs', HOME);
    args.push('--perms', '0755', '--size', String(disk), '--tmpfs', WORKSPACE);
    args.push('--ro-bind', spec.netDir, NET_DIR);
    args.push('--ro-bind', spec.supervisorPath, SUPERVISOR);
    for (const b of binds) args.push(...b);
    args.push('--remount-ro', '/', '--chdir', WORKSPACE);
    if (spec.seccompFd != null) args.push('--seccomp', String(spec.seccompFd));
    args.push('--', nodeInside, SUPERVISOR);
    return { args, env, shell, inside: { node: nodeInside, browser: browserInside } };
}

module.exports = { buildArgs, etcFiles, sandboxEnv, ETC_READ_ONLY, UID, GID, HOME, WORKSPACE, PROXY_PORT, NET_DIR, SUPERVISOR };
