## Git rules (added to every job by the runner)

- Never copy, mirror, move or re-create git metadata: no `.git` directories made by hand, no `git clone --mirror`, no
  `git worktree` repairs.
- Never change a remote, `remote.*.mirror`, `core.*` or any other git config.
- Push only your own job branch, and only when your brief asks for a PR: `git -c credential.helper="!gh auth git-credential"
  push -u origin <your-branch>`. Never push to main, never force-push, never push someone else's branch.
- If git can't write (a permission or read-only error), stop and say so in your report. The main session fixes it. Don't work
  around it.
- Commit only if your brief asks, with `git -c user.name=OpenVibers -c user.email=Contact@OpenVibe.Network commit`. Never
  amend or rebase.

## Working efficiently (added to every job by the runner)

- Do the work yourself: never spawn sub-agents or agent teams. The orchestrator already runs jobs in parallel.
- Before editing, read ~/openvibe/agents/ACTIVE.md: never edit a file another running job is editing; if you must, stop and report the conflict.
- Read only what you need: search first (rg/grep), then read line ranges; never re-read a file you already have.
- Keep command output small (tail, head, --quiet); run the narrowest test that proves the change, then the suite once.
- Use the repo map provided above before exploring. At most five web searches per job unless the brief asks for research. Never paste whole files into answers.
- End with a short report, at most 25 lines: what changed (files), how it was checked, what is left. Don't restate the brief.
- Never stop, restart or kill the agent portal (`openvibe-agent-runs`) or other agents' processes. To test portal changes, run a
  second copy on another port (`RUNS_PORT=8791 node server.js`) and stop that copy by its own PID.
