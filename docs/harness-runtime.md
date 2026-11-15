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
| `claude-code` | structured | resume | git | native | session | native |
| `claude-other` | structured | resume | git | native | session | native |
| `codex` | structured | resume | git | none | session | native |
| `opencode` | structured | resume | git | none | session | client-boundary |
| `command-code` | structured | resume | git | none | session | client-boundary |
| `aider` | parsed | none | git | none | none | client-boundary |
| `minimax-code` | structured | resume | git | none | session | native |
| `deepseek` | structured | resume | git | none | session | client-boundary |
| `openvibe-ai` | structured | resume | git | none | session | client-boundary |
| `openai-compatible` | structured | resume | git | none | session | client-boundary |

`checkpointing` is `git` on every row: a job pins its clone to `refs/codes/checkpoints/<task>/<run>/<n>` per turn
(`harness/job.js`, `harness/checkpoints.js`) and can restore the last good one; the refs are the run's own and are
never pushed.

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

## The API rows' own loop

`deepseek`, `openvibe-ai` and `openai-compatible` run Codes' own loop (`harness/adapters/api.js`) over any
Chat Completions API, and it is kept small and steady:

- **A small fixed prompt.** About 540 tokens before the task (the system message and six tools, in a fixed name
  order), byte-identical from one task to the next, so a provider's prefix cache holds it.
- **Asked again when busy.** A 429 or a 503 is asked again twice and a 500, 502, 504, 408 or a dropped connection
  once (it may have run), after the server's `Retry-After` (at most 30 s) or 2 s and then 6 s; the reader sees a
  warning each time. Any other refusal ends the run with the server's words.
- **A bounded conversation.** Past 240,000 characters (about 65k tokens; `OPENVIBE_CODES_CONTEXT_CHARS`, or the
  run's `adapterOptions.contextChars`) the oldest tool output, and the text of old file writes and edits, become a
  short note saying how much was dropped, down to 60% in one go, so the cached prefix breaks once a trim and not on
  every turn. The system message and the last eight messages are never touched.
- **Edits that land** (ported from OpenCode's edit tool, MIT): `old_string` is matched exactly, then forgiving
  typographic quotes, dashes and odd spaces, then trailing whitespace line by line, on the file's LF view so CRLF and
  mixed endings survive; `replace_all` edits every match; a miss names the closest lines (numbered like `read_file`)
  or says the edit is already there. The text is spliced in, so a `new_string` holding `$&` or `$1` is written as it is
  (`String.replace` rewrote those before).
- **A valid resume.** The saved conversation keeps the system message and starts at a person's message, never at a
  tool result whose call was cut off.
- **grep through ripgrep** where it is installed (`OPENVIBE_CODES_RG` names it, `off` turns it off): the same
  `path:line: text` answer, 200 matches at most, no `.env`, no symlink followed, and off the server's event loop
  (the Live repository: 12-17 ms against 324-544 ms). A pattern only JavaScript reads (a look-behind) still works.

## ACP agents: every agent that speaks the Agent Client Protocol

`harness/adapters/acp.js` is one client for the Agent Client Protocol (JSON-RPC over the agent's stdin and stdout,
agentclientprotocol.com), the protocol T3 Code, Zed and JetBrains drive agents with. `harness/acp-agents.json` pins
16 agents from the public ACP registry, each at its exact version, launched with `npx` or `uvx` (a binary from the
registry is never downloaded and run): Claude and Codex through their ACP bridges (`claude-acp`, `codex-acp`), Gemini CLI
(`gemini-cli`), Qwen Code, Kimi Code, Grok, GitHub Copilot (`copilot-cli`), Cline, Kilo, LangChain's `deepagents`,
Auggie, Qoder, CodeBuddy, GLM, Pi and Factory's Droid. `node scripts/acp-registry.js` refreshes the versions; an agent is
added to its list by hand.

- **One conversation:** `initialize` → `session/new` (or `session/load` to resume, when the agent can) →
  `session/set_model` when the agent offers the asked model → `session/prompt` until its `stopReason`. Its
  `session/update`s become Codes' events: text (chunks joined into whole messages), tool calls and their results, the
  plan, the cost when the agent reports one.
- **Codes answers the agent:** a permission request by the task's level (read: reads, searches and fetches; edit: also
  edits, deletes and moves; full: also commands; a kind the protocol adds later needs full), and file reads and writes
  inside the working directory only, with the API harness's own checks (no `..`, no link out, no `.env`, no `.git`
  write). Anything else is "method not found".
- **Stop:** `session/cancel`, then eight seconds before the process is killed. An agent's own words before a bare
  "Internal error" (a plan's usage limit, a missing sign-in) are kept in the result.
- **What it needs:** Node.js (`npx`) or uv (`uvx`) on the machine and the agent's own sign-in there; the first run fetches
  the pinned package. Checked 11-15 against the real `claude-acp` (a read-only task: one tool call, the answer, the cost)
  and `codex-acp` (the session opened; the plan's usage limit came back in words).
