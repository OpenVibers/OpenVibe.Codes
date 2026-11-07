'use strict';
/**
 * The chat plays sandbox's seccomp filter: a classic BPF program bubblewrap loads (`--seccomp FD`) just before it
 * executes the sandbox's first process. Everything the sandbox runs inherits it and cannot remove it (no_new_privs).
 *
 * It is a deny list on top of the namespaces, not the boundary itself: the calls a build-and-browse agent never needs
 * and that are the kernel's usual attack surface or a way to reach something outside, answered EPERM:
 *
 *   the kernel keyring (keyctl, add_key, request_key: a login's keys live there), ptrace and process_vm_* (reading
 *   another process), namespaces and mounts (unshare, setns, mount, the new mount API, pivot_root), bpf, perf_event_open,
 *   userfaultfd, io_uring, kernel modules and kexec, file handles (open_by_handle_at), syslog, swap, reboot, acct,
 *   quotactl, and on x86-64 iopl/ioperm.
 *
 * Any other architecture's calls (i386 or x32 on an x86-64 kernel, which have their own numbers) kill the process: a
 * filter keyed on x86-64 numbers must not be bypassed by changing ABI.
 *
 *   compile(arch = process.arch) → Buffer (struct sock_filter[]) or null when the architecture is not supported
 */

// The numbers (asm/unistd_64.h on x86-64; asm-generic/unistd.h on arm64).
const SYSCALLS = {
    x64: {
        ptrace: 101, syslog: 103, vhangup: 153, pivot_root: 155, acct: 163, mount: 165, umount2: 166, swapon: 167, swapoff: 168,
        reboot: 169, iopl: 172, ioperm: 173, init_module: 175, delete_module: 176, quotactl: 179, lookup_dcookie: 212,
        kexec_load: 246, add_key: 248, request_key: 249, keyctl: 250, unshare: 272, perf_event_open: 298,
        name_to_handle_at: 303, open_by_handle_at: 304, setns: 308, process_vm_readv: 310, process_vm_writev: 311,
        finit_module: 313, kexec_file_load: 320, bpf: 321, userfaultfd: 323, io_uring_setup: 425, io_uring_enter: 426,
        io_uring_register: 427, open_tree: 428, move_mount: 429, fsopen: 430, fsconfig: 431, fsmount: 432, fspick: 433,
        mount_setattr: 442,
    },
    arm64: {
        lookup_dcookie: 18, umount2: 39, mount: 40, pivot_root: 41, vhangup: 58, quotactl: 60, acct: 89, unshare: 97,
        kexec_load: 104, init_module: 105, delete_module: 106, syslog: 116, ptrace: 117, reboot: 142, add_key: 217,
        request_key: 218, keyctl: 219, swapon: 224, swapoff: 225, perf_event_open: 241, open_by_handle_at: 265,
        name_to_handle_at: 264, setns: 268, process_vm_readv: 270, process_vm_writev: 271, finit_module: 273, bpf: 280,
        userfaultfd: 282, kexec_file_load: 294, io_uring_setup: 425, io_uring_enter: 426, io_uring_register: 427,
        open_tree: 428, move_mount: 429, fsopen: 430, fsconfig: 431, fsmount: 432, fspick: 433, mount_setattr: 442,
    },
};
const AUDIT_ARCH = { x64: 0xc000003e, arm64: 0xc00000b7 };
const X32_SYSCALL_BIT = 0x40000000;

// Classic BPF (linux/filter.h, linux/seccomp.h).
const LD_W_ABS = 0x20;     // BPF_LD | BPF_W | BPF_ABS
const JEQ_K = 0x15;        // BPF_JMP | BPF_JEQ | BPF_K
const JGE_K = 0x35;        // BPF_JMP | BPF_JGE | BPF_K
const RET_K = 0x06;        // BPF_RET | BPF_K
const RET_ALLOW = 0x7fff0000;
const RET_KILL_PROCESS = 0x80000000;
const RET_ERRNO_EPERM = 0x00050000 | 1;
const OFF_NR = 0;
const OFF_ARCH = 4;

function insn(code, jt, jf, k) {
    const b = Buffer.alloc(8);
    b.writeUInt16LE(code, 0);
    b.writeUInt8(jt, 2);
    b.writeUInt8(jf, 3);
    b.writeUInt32LE(k >>> 0, 4);
    return b;
}

/** The denied calls of an architecture, by name. */
function denied(arch = process.arch) {
    return SYSCALLS[arch] ? Object.keys(SYSCALLS[arch]).sort() : [];
}

/** The filter for an architecture, or null when there is none for it (the sandbox then runs without one, and says so). */
function compile(arch = process.arch) {
    const table = SYSCALLS[arch];
    if (!table) return null;
    const prog = [
        insn(LD_W_ABS, 0, 0, OFF_ARCH),
        insn(JEQ_K, 1, 0, AUDIT_ARCH[arch]),
        insn(RET_K, 0, 0, RET_KILL_PROCESS),
        insn(LD_W_ABS, 0, 0, OFF_NR),
    ];
    if (arch === 'x64') prog.push(insn(JGE_K, 0, 1, X32_SYSCALL_BIT), insn(RET_K, 0, 0, RET_ERRNO_EPERM));
    for (const nr of [...new Set(Object.values(table))].sort((a, b) => a - b)) {
        prog.push(insn(JEQ_K, 0, 1, nr), insn(RET_K, 0, 0, RET_ERRNO_EPERM));
    }
    prog.push(insn(RET_K, 0, 0, RET_ALLOW));
    return Buffer.concat(prog);
}

module.exports = { compile, denied, SYSCALLS, AUDIT_ARCH };
