# The runtime capability manifest

Every harness in `server/data/harness-offers.json` declares what it can actually do at runtime, in
`engine/runtime.js`. The manifest is data, not a provider-name check: a task states the capability it needs and the
router excludes every harness that does not declare it, with a reason. This is the plan's "runtime capability
manifest on every harness offer" (Release 1, feat 12; t3code's provider capability system is the model).

The catalog row cannot carry it: `platform.harness-offer@1` closes the row to unknown fields. The contract's own place
for a runtime capability is the offer's `capabilities` array, so `toOffer()` (`server/domain/harness-placement.js`)
turns each field into one `harness:<field>-<value>` capability. A harness the manifest does not know declares
nothing, and is excluded only when a requirement is set.

## Fields and values

| field | values | meaning |
|---|---|---|
| `terminal_status` | `structured` | a machine-readable result line (stream-json, or the API loop's own events) |
| | `parsed` | Codes reads the CLI's prose and decides from it |
| | `none` | nothing to read |
| `steering` | `live` | a message can be appended to the running session |
| | `resume` | the session is continued by id, after or between runs |
| | `none` | a new run starts over |
| `checkpointing` | `git` | Codes can write the worktree to a git ref and restore it |
| | `none` | no checkpoint |
| `subagents` | `native` | the harness's own children, with its own lifecycle and completion |
| | `tool` | children through a shell or protocol with no lifecycle report |
| | `none` | no children |
| `context_handoff` | `session` | the harness's session id resumes the conversation |
| | `transcript` | Codes' own store replays it |
| | `none` | only the hand-off note |
| `enforcement` | `native` | the harness's own sandbox or permission mode |
| | `client-boundary` | Codes' tool loop, or a sandbox Codes requires around it |

## The rows

| harness | terminal_status | steering | checkpointing | subagents | context_handoff | enforcement |
|---|---|---|---|---|---|---|
| `claude-code` | structured | resume | none | native | session | native |
| `claude-other` | structured | resume | none | native | session | native |
| `codex` | structured | resume | none | none | session | native |
| `opencode` | structured | resume | none | none | session | client-boundary |
| `command-code` | structured | resume | none | none | session | client-boundary |
| `aider` | parsed | none | none | none | none | client-boundary |
| `minimax-code` | structured | resume | none | none | session | native |
| `deepseek` | structured | resume | none | none | session | client-boundary |
| `openvibe-ai` | structured | resume | none | none | session | client-boundary |
| `openai-compatible` | structured | resume | none | none | session | client-boundary |

`checkpointing` flips to `git` on every row when the per-turn checkpoint refs land (`harness/job.js`): the manifest is
the runtime's declaration, so it must not claim a checkpoint before one exists.

## Using it

```js
const runtime = require('./engine/runtime');

runtime.forHarness('codex');                     // the fields
runtime.capabilities(runtime.forHarness('codex')); // ['harness:terminal-status-structured', …]
runtime.fits('cm', { subagents: 'native' });     // true: cm is Claude Code
runtime.fits('mm', { subagents: 'native' });     // false: MiniMax Code declares none
```

- `POST /api/v1/harnesses/route` and `openvibe-codes route --need` take the capability names directly:
  `{ "requirements": { "capabilities": ["harness:steering-resume"] } }`.
- `engine/router.js` `pick()` takes `needs` as the names or as `{ field: value }`, and skips a ladder rung whose
  harness does not declare it.
- `test/harness-runtime.test.js` keeps the manifest, the catalog and both routers in step; a harness added to the
  catalog without a manifest fails it.
