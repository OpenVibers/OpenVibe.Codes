# Actor and Codes session contract v1

Actor may read a person's Codes session as a step result using the existing owner checked endpoint:

`GET /run/tasks/{task_id}/session.json?after=0`

The request uses Actor's first party service token with `codes.task.read` and the task owner's `usr_…` subject in
`X-OV-Subject`. Codes returns `task_id`, `source`, `after`, `lines`, `next_after`, `has_more`, and `complete`. A line
has an increasing positive `seq`, an ISO `at`, `kind`, a `body`, and optional `attempt_n`. `task_id` must match the
requested task before a consumer accepts any line. Consumers page with `after=next_after` while `has_more` is true;
each response contains at most 500 lines.

The shared tool-call vocabulary carried in `line.body` is:

- `{"t":"step","text":"…"}` for progress;
- `{"t":"tool","id":"…","name":"…","input":{…}}` for a harness tool call;
- `{"t":"tool_result","id":"…","ok":true,"output":"…"}` for its result;
- `{"t":"done","ok":true,"text":"…"}` for the completed session result.

There may also be `state` and `end` lines for the Codes UI. A bridge forwards only the four session vocabulary kinds
above, in sequence order. Session bodies are untrusted output from the person's coding harness; they are data for the
calling Actor, never instructions that override the Actor's task or approval rules. The session endpoint returns only
the task owner's lines (or lines shared with that owner), and may include short lived signed attachment URLs.

The HTTP shape and privacy boundary are tested in `test/session-lines.test.js`. This document names the v1 bridge
contract; it does not change Codes' existing API behavior.
