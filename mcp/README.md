# mcp/

Bundled MCP servers for this plugin. OpenCode loads MCP servers from the `mcp` key in
`opencode.json` (a plugin **cannot** register an MCP server programmatically), so you must wire
the server up yourself. The server code lives here.

## spark-connect

`spark-connect/server.mjs` — a zero-dependency Node MCP stdio server that manages a **DLP Spark
Connect session** (a SparkConnect *job*) through the **DLP RPC API** (the raw
`yc managed-spark job ...` API answers `Permission denied` for DLP-owned clusters):

| Tool | API method | Body |
| :--- | :--------- | :--- |
| `create_spark_connection` | `POST /rpc/createSparkJob` | `{ clusterId, name?, catalogs?: [{catalogId}], sparkConnectJob: {} }` |
| `list_spark_jobs`         | `POST /rpc/listSparkJobs`  | `{ clusterId, pageSize?, pageToken? }` — find the job's `connectUrl` |
| `cancel_spark_connection` | `POST /rpc/cancelSparkJob` | `{ clusterId, jobId }` |

`cluster_id` is the **DLP SparkCluster id** (`b6p...`, field `id` of `list_spark_clusters`), not
the YC managed cluster id. Per-call args: `environment: "prod" (default) | "preprod"`,
`org_id` (or `DLP_ORG_ID` env, or `YC_SPARK_CLUSTER_ID` env for the cluster id). The server mints
the IAM token itself via `yc` (`--profile sandbox-preprod` on preprod) and sends
`x-dl-api-version: 3` + `x-dl-org-id`. Response of `create_spark_connection` may be an async
`LakehouseOperation` — poll it with the `dlp-api` server's `get_lakehouse_operation`.

Building a PySpark `SparkSession` from the job's `connectUrl` + an IAM token is described in the
[`sparkconnect`](../skills/sparkconnect/SKILL.md) skill — the server does not assemble the
connect URI or hold a session.

**Prerequisites:** `yc` CLI installed & authenticated, and `node` on PATH.

### Wiring it in `opencode.json`

Add the server under the top-level `mcp` key. `node` must resolve `server.mjs`; the simplest is
an absolute path. Optional: set `YC_SPARK_CLUSTER_ID` (a DLP cluster id, `b6p...`) so you can
omit `cluster_id` on every call.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-datalens-harness"],
  "mcp": {
    "spark-connect": {
      "type": "local",
      "command": ["node", "/absolute/path/to/node_modules/opencode-datalens-harness/mcp/spark-connect/server.mjs"],
      "environment": {
        "YC_SPARK_CLUSTER_ID": "your-cluster-id"
      }
    }
  }
}
```

For a global install the server path is typically
`$(npm root -g)/opencode-datalens-harness/mcp/spark-connect/server.mjs`.

## dlp-api

`dlp-api/server.mjs` — a zero-dependency Node MCP stdio server for the DataLens Platform (DLP)
public RPC API (`api.datalens.tech` / `api.preprod.datalens.tech`, header `x-dl-api-version: 3`):

| Tool | API method | Body |
| :--- | :--------- | :--- |
| `run_sql_query` | `POST /rpc/runSqlQuery` | `{ sqlQueryId, params? }` — runs a **saved** DLP SQL query by id |
| `list_catalogs` | `POST /rpc/listCatalogs` | `{ pageSize?, pageToken? }` — lists the org's REST catalogs (lakehouse/Iceberg) |
| `get_api_spec` | `GET /json/` | public OpenAPI 3.1 spec; `path_filter?` slims it to matching paths (spec is ~750 KB) |
| `list_spark_clusters` | `POST /rpc/listSparkClusters` | `{ pageSize?, pageToken?, filter? }` — clusters with id/clusterId/collectionId/cloudEnvironmentId/config/health/status |
| `create_spark_cluster` | `POST /rpc/createSparkCluster` | `{ collectionId, cloudEnvironmentId, name, …, config.resourcePools.{driver,executor} }` — returns an async `LakehouseOperation` |
| `get_lakehouse_operation` | `POST /rpc/getLakehouseOperation` | `{ operationId }` — poll a create/delete cluster operation until `done=true` |

Spark-cluster workflow: `list_spark_clusters` (learn `cloudEnvironmentId` from an existing
cluster) → `create_spark_cluster` → poll `get_lakehouse_operation(operationId)` (~5 min) → the
finished `Cluster` arrives in `operation.response`. The gateway validates resource presets
(e.g. `c2-m8` was rejected as `unsupported driver resource preset` while `c4-m16` passed) and
there is no API to list supported presets.

Per-call arguments (same for both tools): `iam_token` (or `DLP_IAM_TOKEN` env), `org_id`
(or `DLP_ORG_ID` env), `environment: "prod" (default) | "preprod"` (or `DLP_ENVIRONMENT` env),
and a rarely needed `base_url` override (or `DLP_API_BASE_URL` env). The token is **not** fetched
by the server — obtain a fresh one with the `get_iam_token` tool / `yc iam create-token`
(preprod: `yc --profile sandbox-preprod iam create-token`).

### Wiring it in `opencode.json`

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-datalens-harness"],
  "mcp": {
    "dlp-api": {
      "type": "local",
      "command": ["node", "/absolute/path/to/node_modules/opencode-datalens-harness/mcp/dlp-api/server.mjs"],
      "environment": {
        "DLP_ORG_ID": "your-org-id"
      }
    }
  }
}
```

The plugin itself merges this `mcp.dlp-api` entry into the global `opencode.json` idempotently
(unless you already configured one by that name).

### Side-cars logging

Same scheme as `spark-connect`, log file `<project>/side-cars/dlp-api.log` (or
`<project>/side-cars/<session>/logs/dlp-api.log` with `OPENCODE_SESSION_ID` set). Never logs
tokens or param values.

### Side-cars logging

OpenCode spawns a local MCP server **once** (shared across sessions) and does not inject a session
id into it. So `server.mjs` logs at the **project** level to `<project>/side-cars/spark-connect.log`
(project root = the server's `cwd`). If you set `OPENCODE_SESSION_ID` in `environment`, logging
becomes session-scoped: `<project>/side-cars/<session>/logs/spark-connect.log`. Logging is
best-effort and never logs `connect_url` or token values.

### Notes

- OpenCode MCP tools are surfaced namespaced by the server name (`spark-connect`).
- After editing `mcp` or the server, restart OpenCode.
