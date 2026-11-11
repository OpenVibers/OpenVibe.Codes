# Model plans

Model plans choose how a coding task uses OpenVibe.AI models. A plan has a mode, a list of roles, and checks. Every role call goes through AI's existing provider routing and uses the task's run token. The saved plan changes task behavior only when the owner enables `CODES_MODEL_PLANS=1`.

## Modes

- `single`: one selected model builds and verifies the result.
- `pair`: a builder and a reviewer; the reviewer must approve. Findings return to the builder once.
- `council`: two or three planner proposals; a judge picks or merges them with reasons before building and review.
- `escalate`: start at the first ladder model and move up on a failed check, model refusal or low confidence. The task records the reason.

The copyable presets are Fast, Balanced, Deep and Council. Read them at `GET /api/v1/model-plans/presets`. Each role names an AI registry model id or `auto`, an effort from `none`, `low`, `medium`, `high`, `xhigh`, `max`, and optionally 1–5 samples and a token, minute or dollar budget. Saving checks availability and price against AI's registry; an unavailable id uses the first available model in the plan's ladder and returns that reason.

## Configuration

The account default is saved at `PUT /api/v1/model-plans` with `{ "plan": { ... } }`. Add `?project=<id>` for a saved project default. A repository may contain `.openvibe/codes.yml`:

```yaml
models:
  mode: pair
  roles:
    - role: builder
      model: openvibe/auto
      effort: high
    - role: reviewer
      model: openvibe/auto
      effort: medium
  checks:
    tests: true
    reviewer: true
```

For a task, send `plan` or `preset` in `POST /api/v1/tasks`. The task override wins over repository config, which wins over the saved project plan, which wins over the account default. The repository file is read and validated on the machine after cloning. Invalid YAML or a malformed `models:` block ends the task with a path and line or field error.

`GET /api/v1/tasks/:id` returns the resolved `model_plan` and each role's model, effort, tokens, cost, duration and outcome. The event stream exposes one AG-UI step per role call with `metadata.ov.model`. The verifier reads the final diff and repeats the configured tests and lint before success. The current automatic check runner uses `test` and `lint` scripts from the repository's `package.json`; missing scripts fail the requested check explicitly.
