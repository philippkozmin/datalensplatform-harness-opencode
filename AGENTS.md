# DataLens Platform harness — global instruction

This file is copied by the `opencode-datalens-harness` plugin to
`~/.config/opencode/datalens-harness/AGENTS.md` and its path is added to `config.instructions`
(idempotently, into the global `opencode.json`), so OpenCode includes it in the system prompt on
every turn. It is the file-based carrier of the `main_orchestration`-first rule (the plugin uses
no runtime hooks).

## MANDATORY routing rule

IF the user's request involves **DataLens / DataLens Platform / DLP / dashboards / datasets /
charts / connections / data-processing scripts (SQL / Python / Scala) / Spark / PySpark / Airflow
scheduling / Yandex Managed Spark**, then your **FIRST action** MUST be to call the `skill` tool
with:

```json
{ "name": "main_orchestration" }
```

Do **not** read files, run shell, call any other tool, or answer before you have loaded that
skill. `main_orchestration` sets up:

- the IAM token (via the `get_iam_token` tool),
- the project memory (`memory/infrastructure.md`),
- the session's side-cars inter-agent channel (paths resolved via the `get_harness_session_id` tool),
- the rules for delegating to the `engineer` and `scheduler` subagents.

If — and only if — the request is clearly unrelated to DataLens, ignore this rule.

## Why

OpenCode cannot hard-force a skill to run; the model decides whether to call the `skill` tool.
This instruction (read every turn via `config.instructions`) plus the keyword-rich skill
`description` exist to make non-compliance as unlikely as possible for any DataLens-flavoured
request.
