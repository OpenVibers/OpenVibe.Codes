# Per-turn checkpoints

A coding job clones the repository into a scratch directory and an agent works there. `harness/checkpoints.js` pins
that worktree to a git commit before each tool batch and keeps it under a ref:

```
refs/codes/checkpoints/<task>/<run>/<n>
```

The refs are the run's own history. They are never pushed and never become a branch, and the clone (and so the refs)
is removed when the job ends. What survives is the job result: the refs, each turn's diff, and the final turn diff
against the clone as the agent found it.

## How a checkpoint is written

A checkpoint uses a temporary index (`GIT_INDEX_FILE`) so it never touches the run's own index:

```
read-tree HEAD  →  add -A  →  write-tree  →  commit-tree -p <previous checkpoint>  →  update-ref
```

`.gitignore` and `.git/info/exclude` still apply, so `node_modules`, build output and the owner's `.openvibe/` files
stay out. `n = 0` is the clone as the agent found it; the job takes one more at the end (`final`) for the last turn.

## The turn diff

`checkpoints.turns[]` has one row per checkpoint after the start:

```json
{
  "n": 2, "ref": "refs/codes/checkpoints/tsk_…/run_…/2", "label": "turn 1",
  "from": 1, "to": 2, "files_total": 3, "authored": 2, "imported": 1, "truncated": false,
  "files": [
    { "path": "src/user.js", "status": "M", "added": 4, "removed": 3, "authored": true },
    { "path": "package-lock.json", "status": "M", "added": 120, "removed": 2, "authored": false }
  ]
}
```

A file is **authored** when a tool call named it during the run (Claude Code's tool vocabulary, whatever harness ran)
and **imported** otherwise: a patch applied from an earlier conversation, a dependency install, a formatter, a
subagent's work. `status` is git's letter (`A`, `M`, `D`, `R`); `checkpoints.turn_diff` is the whole run against
`n = 0`. A result carries at most 20 turns and 20 files a turn (`files_total` says how many there really were).

## Restoring

`createCheckpoints(...).restore(n)` puts the worktree back to a checkpoint: `read-tree --reset -u` of its tree, then
`git clean -fdq` for the untracked files a broken turn left (ignored files stay). The last checkpoint is the last good
state before the current turn. This is the operation a **failed repair** uses: the repair loop (After-Loops AL2, the
same builder resumed with findings) restores the last good turn before it retries, rather than asking the model to
re-read and re-edit from a broken tree. Routine hand-offs do **not** restore: when an agent runs out of its plan
mid-work, the next agent keeps that work (the hand-off note tells it what was done).

The module is tested in `test/checkpoints.test.js`; a job's integration (refs written, the agent's own file marked
authored, the failed run still carrying its diffs) runs in the same file against a real local clone.
