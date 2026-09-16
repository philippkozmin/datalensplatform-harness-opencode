---
name: sparkconnect
description: Build a PySpark SparkSession against a DataLens Platform (DLP) Spark Connect job. Use when the user needs a SparkSession / Spark Connect / PySpark remote session on a DLP Spark cluster — it wires the DLP RPC methods (createSparkJob / listSparkJobs / cancelSparkJob) together with an IAM token into a working SparkSession.builder.remote(...) call, and can attach REST catalogs (Iceberg) to the session.
---

# sparkconnect — build a PySpark SparkSession over Spark Connect

Goal: get a working PySpark `SparkSession` connected to a DLP Spark cluster via Spark Connect.
A Spark Connect session is a **SparkConnect job** on the cluster; you create the job through the
**DLP RPC API**, read its `connectUrl`, and point PySpark at it with an IAM token.

> **Do NOT use `yc managed-spark job ...` for DLP clusters.** DLP clusters are owned by the
> lakehouse gateway: the raw YC CLI/API answers `Permission denied`. The only supported path is
> the DLP RPC API below (or MCP tools that wrap it).

Common RPC envelope (every method is `POST <base>/rpc/<method>` with JSON body):

- headers: `Authorization: Bearer <IAM token>`, `x-dl-api-version: 3`, `x-dl-org-id: <org>`
- prod base `https://api.datalens.tech`, preprod base `https://api.preprod.datalens.tech`
- Spark methods: `createSparkJob`, `listSparkJobs`, `getSparkJob`, `cancelSparkJob`,
  `listSparkJobLog`; cluster methods: `listSparkClusters`, `getSparkCluster`.
- `clusterId` in these methods is the **DLP** SparkCluster id (`b6p...` — field `id` from
  `listSparkClusters`), **not** the YC managed cluster id (`e4u...`, field `clusterId`).

## Step 1 — IAM token

Obtain a fresh IAM token (`get_iam_token` tool / `yc iam create-token`; preprod:
`yc --profile sandbox-preprod iam create-token`). The token is valid for at most 12 hours and is
embedded in the connect URI. Never write the token into side-cars files.

## Step 2 — Create the SparkConnect job (DLP RPC `createSparkJob`)

```json
POST /rpc/createSparkJob
{
  "clusterId": "<DLP SparkCluster id>",
  "name": "my-connect",
  "catalogs": [ { "catalogId": "<REST catalog id, optional — attaches the Iceberg catalog>" } ],
  "sparkConnectJob": {}
}
```

- `name` pattern: `[a-z][-a-z0-9]{1,62}[a-z0-9]` (lowercase).
- `catalogs[]` — REST catalogs (from `POST /rpc/listCatalogs`, field `id`) attached to the job's
  Spark config; the catalog becomes usable in SQL as its **name** (e.g.
  `` SELECT * FROM `catalog-name`.marts.some_table ``).
- The response may be an async `LakehouseOperation` — poll it with
  `POST /rpc/getLakehouseOperation {"operationId": "<id>"}` until `done=true` (note the field is
  **operationId**, not `id`); the job/cluster resource comes in `response`.
- If the gateway answers `refresh token is not found for user "<user-id>"`, the DLP user has no
  stored OAuth refresh token yet: ask the user to log in once to the DLP UI (preprod →
  https://preprod.datalens.ru) and start a session/compute from the UI, then retry.

## Step 3 — Find the job and its connectUrl

`POST /rpc/listSparkJobs {"clusterId": "<DLP id>"}` (or `getSparkJob` by job id). Locate your
job by id/name, confirm it is running, and read its **`connectUrl`** (e.g.
`sc://connect-api-...spark.yandexcloud.net:443`). If the job is not running yet or `connectUrl`
is empty, wait briefly and list again.

## Step 4 — Build the SparkSession in PySpark

The IAM token is passed **inside** the remote URI as `token=...`, with `use_ssl=true`. The PySpark
version must match the cluster's Spark version (supported: `3.5.6`, `3.5.7`; system-wide 4.x is
NOT compatible — use a venv with `pyspark==3.5.7`).

```python
import os
from pyspark.sql import SparkSession

connect_url = "<connectUrl from listSparkJobs>"       # e.g. sc://connect-api-...:443
iam_token   = os.environ["IAM_TOKEN"]                 # from Step 1

spark = (
    SparkSession.builder
    .remote(f"{connect_url}/;use_ssl=true;token={iam_token}")
    .getOrCreate()
)

# smoke test
spark.createDataFrame([(1, "Sarah"), (2, "Maria")], ["id", "name"]).show()

# attached REST catalog: catalog name from listCatalogs is the SQL namespace
spark.sql("SELECT * FROM `dlback-test-catalog-10`.marts.mart_orders_ab_test LIMIT 2").show()
```

## Step 5 — Shut it down (mandatory on any exit)

Cancelling the SparkConnect job is **required cleanup, not optional** — do it whenever
execution stops: on success, on failure, or on abort. Cancel with
`POST /rpc/cancelSparkJob {"clusterId": "<DLP id>", "jobId": "<job id>"}` as the final action so
no Spark job is left running. Jobs in `ERROR` / `DONE` / `CANCELLED` cannot be cancelled.

When driven by the `engineer` subagent, this teardown must fire even after the engineer hits its
retry budget (**≤ 3 timeout errors, or ≤ 1 non-timeout error, then stop**) — see
[`engineer`](../../agents/engineer.md).

## Notes

- The connect URI embeds a live IAM token — treat it as a secret, use it inline, do not persist it.
- MCP tools of the `dlp-api` server wrap the same RPCs (`create_spark_connection`,
  `list_spark_jobs`, `cancel_spark_connection`, `list_catalogs`); pass DLP cluster ids there too.
- The gateway validates resource presets on cluster creation (e.g. `c2-m8` rejected,
  `c4-m16` accepted) — see the `dlp-api` MCP tools for cluster management.
