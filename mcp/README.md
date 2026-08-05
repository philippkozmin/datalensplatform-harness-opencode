# mcp/

Bundled MCP servers for this plugin. OpenCode loads MCP servers from the `mcp` key in
`opencode.json` (a plugin **cannot** register an MCP server programmatically), so you must wire
the server up yourself. The server code lives here.

## spark-connect

`spark-connect/server.mjs` — a zero-dependency Node MCP stdio server that manages a Yandex
Managed Spark **Spark Connect** session (a SparkConnect *job*) by shelling out to the `yc` CLI:

| Tool | Action | `yc` command |
| :--- | :----- | :----------- |
| `create_spark_connection` | Create the SparkConnect job | `yc managed-spark job create-spark-connect` |
| `list_spark_jobs`         | List jobs / find `connect_url` & status | `yc managed-spark job list` |
| `cancel_spark_connection` | Cancel (shut down) the job | `yc managed-spark job cancel` |

Building a PySpark `SparkSession` from a job's `connect_url` + an IAM token is described in the
[`sparkconnect`](../skills/sparkconnect/SKILL.md) skill — the server does not assemble the
connect URI or hold a session.

**Prerequisites:** `yc` CLI installed & authenticated, and `node` on PATH.
Cluster id comes from each tool's `cluster_id` argument or the `YC_SPARK_CLUSTER_ID` env var.

### Wiring it in `opencode.json`

Add the server under the top-level `mcp` key. `node` must resolve `server.mjs`; the simplest is
an absolute path. Optional: set `YC_SPARK_CLUSTER_ID` so you can omit `cluster_id` on every call.

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

### Side-cars logging

OpenCode spawns a local MCP server **once** (shared across sessions) and does not inject a session
id into it. So `server.mjs` logs at the **project** level to `<project>/side-cars/spark-connect.log`
(project root = the server's `cwd`). If you set `OPENCODE_SESSION_ID` in `environment`, logging
becomes session-scoped: `<project>/side-cars/<session>/logs/spark-connect.log`. Logging is
best-effort and never logs `connect_url` or token values.

### Notes

- OpenCode MCP tools are surfaced namespaced by the server name (`spark-connect`).
- After editing `mcp` or the server, restart OpenCode.
