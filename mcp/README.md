# mcp/

Bundled MCP servers for this plugin. OpenCode loads MCP servers from the `mcp` key in
`opencode.json` (a plugin **cannot** register an MCP server programmatically), so you must wire
the server up yourself. The server code lives here.

## dlp-api

`dlp-api/server.mjs` — a zero-dependency Node MCP stdio server for the **whole DataLens Platform
(DLP) public RPC API** (`api.datalens.tech` / `api.preprod.datalens.tech`, header
`x-dl-api-version: 3`). Since 0.2.0 it also hosts the former `spark-connect` server's tools —
Spark Connect jobs, Spark clusters, catalogs and saved SQL queries all live behind the same
gateway, so there is one server for all of it:

| Tool | API method | Body |
| :--- | :--------- | :--- |
| `run_sql_query` | `POST /rpc/runSqlQuery` | `{ sqlQueryId, params? }` — runs a **saved** DLP SQL query by id |
| `list_catalogs` | `POST /rpc/listCatalogs` | `{ pageSize?, pageToken? }` — lists the org's REST catalogs (lakehouse/Iceberg) |
| `get_api_spec` | `GET /json/` | public OpenAPI 3.1 spec; `path_filter?` slims it to matching paths (spec is ~750 KB) |
| `list_spark_clusters` | `POST /rpc/listSparkClusters` | `{ pageSize?, pageToken?, filter? }` — clusters with id/clusterId/collectionId/cloudEnvironmentId/config/health/status |
| `create_spark_cluster` | `POST /rpc/createSparkCluster` | `{ collectionId, cloudEnvironmentId, name, …, config.resourcePools.{driver,executor} }` — returns an async `LakehouseOperation` |
| `get_lakehouse_operation` | `POST /rpc/getLakehouseOperation` | `{ operationId }` — poll a create/delete cluster operation until `done=true` |
| `create_spark_connection` | `POST /rpc/createSparkJob` | `{ clusterId, name?, catalogs?: [{catalogId}], sparkConnectJob: {} }` — create a Spark Connect session (job) |
| `list_spark_jobs` | `POST /rpc/listSparkJobs` | `{ clusterId, pageSize?, pageToken? }` — find the job's `connectUrl` |
| `cancel_spark_connection` | `POST /rpc/cancelSparkJob` | `{ clusterId, jobId }` — shut a SparkConnect job down |

The raw `yc managed-spark job ...` API answers `Permission denied` for DLP-owned clusters — the
DLP RPC above is the only supported path. Building a PySpark `SparkSession` from the job's
`connectUrl` + an IAM token is described in the
[`sparkconnect`](../skills/sparkconnect/SKILL.md) skill — the server does not assemble the
connect URI or hold a session.

`cluster_id` in the Spark job tools is the **DLP SparkCluster id** (`b6p...`, field `id` of
`list_spark_clusters`), not the YC managed cluster id.

Per-call arguments (same everywhere): `iam_token`, `org_id`, `environment: "prod" (default) |
"preprod"`, and a rarely needed `base_url` override. Resolution order:
`iam_token` arg > `DLP_IAM_TOKEN` env > a fresh token minted by the server via `yc`
(`--profile sandbox-preprod` on preprod); `org_id` arg > `DLP_ORG_ID` env;
`cluster_id` arg > `YC_SPARK_CLUSTER_ID` env.

Spark-cluster workflow: `list_spark_clusters` (learn `cloudEnvironmentId` from an existing
cluster) → `create_spark_cluster` → poll `get_lakehouse_operation(operationId)` (~5 min) → the
finished `Cluster` arrives in `operation.response`. The gateway validates resource presets
(e.g. `c2-m8` was rejected as `unsupported driver resource preset` while `c4-m16` passed) and
there is no API to list supported presets.

**Prerequisites:** `yc` CLI installed & authenticated, and `node` (>= 18) on PATH.

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
        "DLP_ORG_ID": "your-org-id",
        "YC_SPARK_CLUSTER_ID": "optional-default-dlp-cluster-id"
      }
    }
  }
}
```

The plugin itself merges this `mcp.dlp-api` entry into the global `opencode.json` idempotently
(unless you already configured one by that name). Versions < 0.2.0 wrote an `mcp.spark-connect`
entry pointing at a now-removed server — the plugin cleans that stale entry up (only when it
points at the harness-shipped path; a custom `spark-connect` server of yours is never touched).

### Side-cars logging

OpenCode spawns a local MCP server **once** (shared across sessions) and does not inject a session
id into it. So `server.mjs` logs at the **project** level to `<project>/side-cars/dlp-api.log`
(project root = the server's `cwd`). If you set `OPENCODE_SESSION_ID` in `environment`, logging
becomes session-scoped: `<project>/side-cars/<session>/logs/dlp-api.log`. Logging is
best-effort and never logs tokens, `connect_url`, or param values.

### Notes

- OpenCode MCP tools are surfaced namespaced by the server name (`dlp-api_*`).
- After editing `mcp` or the server, restart OpenCode.
