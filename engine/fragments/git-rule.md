## Git rules (added to every job by the runner)

- Never copy, mirror, move or re-create git metadata: no `.git` directories made by hand, no `git clone --mirror`, no
  `git worktree` repairs.
- Never change a remote, `remote.*.mirror`, `core.*` or any other git config. Never push.
- If git can't write (a permission or read-only error), stop and say so in your report. The main session fixes it. Don't work
  around it.
- Commit only if your brief asks, with `git -c user.name=OpenVibers -c user.email=Contact@OpenVibe.Network commit`. Never
  amend or rebase.
