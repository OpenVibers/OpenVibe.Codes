# Agent run streams

`GET /api/v1/runs/:id` returns an `agent.run@1` snapshot; a task ID resolves its latest attempt. The returned `id` (`task-id~attempt-number`) pins that run for replay.
`GET /api/v1/runs/:id/events` streams AG-UI events with numeric SSE `id`, an `event` type and JSON `data`.
Reconnect with `Last-Event-ID`. The server sends keep-alive comments and closes after RUN_FINISHED/RUN_ERROR.
The same codes.task.read guard, owner/service scope and sharing checks as `/tasks/:id` apply.

The owner switch is `agentRuns` in the existing `codes.ai` configuration namespace (`/internal/config/codes.ai`).
It starts off. `CODES_AGENT_UI=1` or `0` pins the switch. Activate the owner setting after checking production;
thereafter the stored setting is the site's default and may be disabled live. No UI change is included.

The projection retains its event sequence and titles in PostgreSQL; concurrent readers serialize on the run.
Known tools use tool/target titles. Unknown tools use a bounded, cached small-model request through OpenVibe.Exchange;
unavailable credentials/models fall back to “Performed an action”. Model input is only the redacted tool and target.
Consecutive matching kinds carry a group ID/count; narrative, approvals, handoffs and failures break groups.
Full redacted tool output remains in the result event; metadata carries a one-line summary. Web result sources are
HTTPS-only, deduplicated by URL and preserve structured titles. Existing historical clipped outputs cannot be recovered.

The stream waits for final session backfill before closing. Each attempt has a separate immutable projection, so
a continuation receives a new run ID and never appends events after the previous RUN_FINISHED.

Grouping, one-line summaries and step status are carried in `metadata["ov.step"]`; the reserved `metadata.ov`
contains the contract's title, kind, sources, attachments, cost, needs_you, product and ref fields.
