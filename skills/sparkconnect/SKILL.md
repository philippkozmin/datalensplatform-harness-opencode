---
name: sparkconnect
description: Build a PySpark SparkSession against a Yandex Managed Spark (DataLens Platform) Spark Connect job. Use when the user needs a SparkSession / Spark Connect / PySpark remote session on a DLP Spark cluster — it wires the create_spark_connection, list_spark_jobs, and cancel_spark_connection MCP tools together with an IAM token into a working SparkSession.builder.remote(...) call.
---

# sparkconnect — build a PySpark SparkSession over Spark Connect

Goal: get a working PySpark `SparkSession` connected to a Yandex Managed Spark cluster via
Spark Connect. A Spark Connect session is a **SparkConnect job** on the cluster; you create the
job, read its `connect_url`, and point PySpark at it with an IAM token.

You need the cluster id. Pass it as `cluster_id` to the MCP tools, or set `YC_SPARK_CLUSTER_ID`.

The `create_spark_connection`, `list_spark_jobs`, and `cancel_spark_connection` tools are provided
by the **`spark-connect`** MCP server (configured under the `mcp` key in `opencode.json`). They are
only available if the user has wired that server up — see the harness README.

## Step 1 — IAM token

Obtain a fresh IAM token by calling the **`get_iam_token`** tool (bundled with this harness).
The token is valid for at most 12 hours and is embedded in the connect URI. Never write the token
into side-cars files.

## Step 2 — Create the SparkConnect job

Call the **`create_spark_connection`** tool with the `cluster_id` (and optional `name`). Note the
returned **job id**.

## Step 3 — Find the job and its connect_url

Call the **`list_spark_jobs`** tool with the `cluster_id`. Locate your job by id, confirm it is
running, and read its **`connect_url`** (e.g. `sc://connect-api-...spark.yandexcloud.net:443`).
If the job is not running yet or `connect_url` is empty, wait briefly and list again.

## Step 4 — Build the SparkSession in PySpark

The IAM token is passed **inside** the remote URI as `token=...`, with `use_ssl=true`. The PySpark
version must match the cluster's Spark version (supported: `3.5.6`, `3.5.7`).

```python
import os
from pyspark.sql import SparkSession

connect_url = "<connect_url from list_spark_jobs>"   # e.g. sc://connect-api-...:443
iam_token   = os.environ["IAM_TOKEN"]                # from Step 1 (get_iam_token)

spark = (
    SparkSession.builder
    .remote(f"{connect_url}/;use_ssl=true;token={iam_token}")
    .getOrCreate()
)

# smoke test
spark.createDataFrame([(1, "Sarah"), (2, "Maria")], ["id", "name"]).show()
```

## Step 5 — Shut it down (mandatory on any exit)

Cancelling the SparkConnect job is **required cleanup, not optional** — do it whenever
execution stops: on success, on failure, or on abort. Cancel the job with the
**`cancel_spark_connection`** tool (pass `cluster_id` and the `job_id`) as the final action so no
Spark job is left running. Jobs in `ERROR` / `DONE` / `CANCELLED` cannot be cancelled.

When driven by the `engineer` subagent, this teardown must fire even after the engineer hits its
retry budget (**≤ 3 timeout errors, or ≤ 1 non-timeout error, then stop**) — see
[`engineer`](../../agents/engineer.md).

## Notes

- The connect URI embeds a live IAM token — treat it as a secret, use it inline, do not persist it.
- The `spark-connect` MCP tools only manage the job lifecycle; this skill owns the connect-string
  assembly and the PySpark session code.
