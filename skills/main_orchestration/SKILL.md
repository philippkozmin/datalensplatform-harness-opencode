---
name: main_orchestration
description: "MANDATORY first skill for ANY work with Yandex DataLens / DataLens Platform (DLP). Invoke this — by calling the `skill` tool with name \"main_orchestration\" — before doing anything else whenever the user asks to work with DataLens, its data, datasets, dashboards, charts, connections, data-processing scripts (SQL / Python / Scala), Spark / PySpark, or Airflow scheduling. It sets up the IAM token, the project memory, the side-cars inter-agent channel, and the rules for delegating to the engineer and scheduler subagents."
---

# DataLens Platform — Main Orchestration

This is the **entry point and required first step for every DataLens task.** Load this skill
before any other DataLens action (the harness also injects a system-prompt mandate to that
effect). It does not do the work itself — it prepares the session and routes the work to the
right subagent.

## Step 0 — Resolve session context (always first)

OpenCode does **not** expose the session id to you directly. Call the **`get_harness_session_id`** tool
(bundled with this harness) to learn the current `sessionID`, the project `directory` / `worktree`,
and the absolute **`sidecarsBase`** path for this session:

```
<worktree>/side-cars/<sessionID>/
```

You will embed these exact absolute paths into every subagent task brief. Do not guess or invent
side-cars paths — use what `get_harness_session_id` returns.

## Step 1 — Refresh the IAM token

The next action of any DataLens work is to **refresh the token** by calling the **`get_iam_token`**
tool. Every DataLens / Yandex Cloud API call needs a fresh `Authorization: Bearer <IAM token>`
header, and the token is valid for at most 12 hours.

Do this at the start of the session and again if the session runs long or a call fails with an
auth error. Never proceed to data or scheduling work without a valid token. The tool result is the
raw token; do **not** write it into any side-cars file.

## Step 2 — Load memory

Read `<worktree>/memory/infrastructure.md` before planning. If it does not exist in the working
project yet, create it with these fields set to `UNKNOWN`:

- **data-processing code repository** — where finished SQL / Python / Scala scripts are saved;
- **scheduling repository (Airflow)** and the **folder** within it where scheduled processes go.

If a fact you need is still `UNKNOWN`, you (the main agent) must find it out from the user
**before** delegating, and then **update the memory file** so the next session has it.

## Step 3 — Set up the side-cars channel

All communication **between subagents, and between a subagent and the main agent, goes through
text files under `sidecarsBase`** — never through hidden channels. Using the `sidecarsBase` from
Step 0, the layout is:

```
<sidecarsBase>/
  <agent>_task.md      # task brief:  main → subagent
  <agent>_result.md    # final result: subagent → main
  <agent>_status.md    # live "currently working on…" heartbeat: subagent → main
  log.md               # append-only coordination / hand-offs
  logs/                # component & command logs (spark-connect.log, get_iam_token.log, <agent>.log)
```

Rules:

- Create the session directory (and its `logs/` subdir) at the start of the session if it does
  not exist.
- The main agent writes a task brief for a subagent to `<sidecarsBase>/<agent>_task.md` before
  launching it (via the `task` tool).
- Each subagent reads its task from that file and writes its output / questions / results to
  `<sidecarsBase>/<agent>_result.md`.
- Each subagent keeps a **status file** (`<agent>_status.md`) with a timestamped line of what it
  is doing right now, and appends command/tool logs under `logs/`.
- Shared, chronological coordination goes into an append-only `<sidecarsBase>/log.md`.
- **Subagents never talk to the user directly.** They communicate only with the main agent, and
  only via side-cars files. The main agent is the sole party that talks to the user.

### Every subagent task brief must include

When writing `<agent>_task.md`, the main agent MUST spell out (do not leave these to the
subagent's discretion):

- **IAM token source.** Tell the subagent to obtain a fresh token itself by calling the
  `get_iam_token` tool. The main agent does **not** pre-set the token in the env and does **not**
  write the token into side-cars.
- **Assigned file paths.** The main agent picks and writes the **exact** paths the subagent must
  use — e.g. `status_file: <sidecarsBase>/<agent>_status.md` and
  `log_file: <sidecarsBase>/logs/<agent>.log`. The subagent uses the paths it is given; it does
  **not** invent its own.
- **Logging/progress duties.** Tell the subagent to keep its status file current, append logs to
  its assigned log file, and write the final result to `<sidecarsBase>/<agent>_result.md`.

### Surface subagent status to the user

While a subagent runs, the main agent **periodically reads that subagent's `<agent>_status.md`
(and `logs/`) and relays the current status to the user.** This is how the user sees live progress
— the subagent still never addresses the user directly.

## Step 4 — Route the work to a subagent

Delegate the actual work. Two subagents exist (see `agents/`): `engineer` and `scheduler`. Launch
either with the `task` tool (`subagent_type: "engineer"` / `"scheduler"`); both are `hidden`
agents, invoked only by the main agent.

### `engineer` — data-processing code development
Use for tasks that require **developing data-processing code in SQL, Python, or Scala.**

Launch it **strictly only if the task is defined in concrete terms:**
- concrete **tables**,
- concrete **databases**,
- the exact **transformations** to perform on them.

If any of these is missing, do **not** launch the engineer — clarify with the user first.

When the work needs a Spark session, use the DLP RPC API (`createSparkJob` with
`sparkConnectJob` + `catalogs`, `listSparkJobs`, `cancelSparkJob` — headers `Authorization`,
`x-dl-api-version: 3`, `x-dl-org-id`) or the `spark-connect` MCP tools wrapping them, and the
[`sparkconnect`](../sparkconnect/SKILL.md) skill to build a PySpark `SparkSession`. Do **not**
create session jobs via `yc managed-spark job ...` — DLP clusters answer `Permission denied`
there.

### `scheduler` — putting scripts on a schedule (Airflow)
Use **strictly** for the task of scheduling **ready** data-processing scripts via Airflow.

Launch it **strictly only if both preconditions hold:**
1. Memory (Step 2) knows the **Airflow scheduling repository and the folder** for putting
   processes on a schedule. If unknown → find it out from the user first and update memory.
2. We know **which scripts** to schedule and **on what schedule**. If unknown → find it out from
   the user first.

If either precondition is unmet, do **not** launch the scheduler — resolve it first.

## Guardrails

- `get_harness_session_id` first to resolve the session's side-cars base path (Step 0).
- Token next, always (Step 1).
- Read and keep memory up to date (Step 2).
- Every inter-agent message is a file under `<sidecarsBase>/` (Step 3).
- Every task brief assigns the token source and the exact status/log paths (Step 3).
- While a subagent runs, poll its `<agent>_status.md` and relay progress to the user.
- Subagents are silent to the user; only the main agent speaks to the user.
- Do not launch a subagent whose preconditions are not met.
