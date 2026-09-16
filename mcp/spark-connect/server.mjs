#!/usr/bin/env node
/**
 * spark-connect — zero-dependency MCP stdio server for DataLens Platform Spark Connect.
 *
 * A Spark Connect session is a SparkConnect *job* on a DLP Spark cluster. The jobs live behind
 * the DLP lakehouse gateway (RPC API), NOT behind the raw `yc managed-spark job ...` API —
 * DLP clusters answer Permission denied there. Tools:
 *
 *   - create_spark_connection : POST /rpc/createSparkJob  (variant sparkConnectJob, catalogs[])
 *   - list_spark_jobs         : POST /rpc/listSparkJobs
 *   - cancel_spark_connection : POST /rpc/cancelSparkJob
 *
 * cluster_id everywhere is the DLP SparkCluster id (b6p...), not the YC managed cluster id.
 * The IAM token is minted via the `yc` CLI (prod: default profile, preprod: sandbox-preprod)
 * and sent as the Authorization Bearer header together with x-dl-api-version: 3 and
 * x-dl-org-id. It does NOT assemble the connect URI or hold a session — building a PySpark
 * SparkSession from the job's connectUrl + an IAM token is described in the `sparkconnect`
 * skill.
 *
 * Protocol: minimal MCP over stdio (newline-delimited JSON-RPC 2.0): initialize, tools/list,
 * tools/call. No external dependencies — runs with plain `node`.
 *
 * Docs: https://api.datalens.tech/#/SparkJobs (OpenAPI spec at GET /json/)
 *
 * ---------------------------------------------------------------------------
 * Side-cars logging (OpenCode)
 *
 * Unlike Claude Code, OpenCode does not inject a session id into MCP server processes — a local
 * MCP server is spawned once and shared across all sessions. So logging here is project-scoped:
 * it writes to `<process.cwd()>/side-cars/spark-connect.log` (project root). If the deployer sets
 * OPENCODE_SESSION_ID (or the legacy CLAUDE_SESSION_ID) in the MCP `environment`, the log is
 * session-scoped instead: `<project>/side-cars/<session>/logs/spark-connect.log`.
 *
 * The project root is `process.cwd()` (OpenCode spawns the server with cwd = project dir).
 * Logging is strictly best-effort: any failure is swallowed so it can never break a tool call.
 * Secrets (connect_url, token=...) are NEVER logged — only tool name, cluster id, job id, status.
 */
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const PROTOCOL_VERSION = "2024-11-05"

function sessionId() {
  return process.env.OPENCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || ""
}

function logTarget() {
  const project = process.cwd()
  if (!project) return null
  const session = sessionId()
  if (session) return { dir: join(project, "side-cars", session, "logs"), file: "spark-connect.log" }
  return { dir: join(project, "side-cars"), file: "spark-connect.log" }
}

function logLine(msg) {
  try {
    const target = logTarget()
    if (!target) return
    mkdirSync(target.dir, { recursive: true })
    const ts = new Date().toISOString()
    appendFileSync(join(target.dir, target.file), `${ts} ${msg}\n`)
  } catch {
    // best-effort: never let logging break a tool call
  }
}

// ---------------------------------------------------------------------------
// yc helper
// ---------------------------------------------------------------------------

/** Run `yc <args...>` and resolve stdout (string). Rejects with stderr on non-zero exit. */
function runYc(args) {
  return new Promise((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    let child
    try {
      child = spawn("yc", args, { stdio: ["ignore", "pipe", "pipe"] })
    } catch (err) {
      reject(new Error(`failed to launch 'yc': ${err.message}`))
      return
    }
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("error", (err) =>
      reject(new Error(`failed to launch 'yc' (is it installed and on PATH?): ${err.message}`)),
    )
    child.on("close", (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`yc ${args.join(" ")} exited ${code}: ${stderr.trim() || stdout.trim()}`))
    })
  })
}

/** Resolve the DLP cluster id from the tool arg or the YC_SPARK_CLUSTER_ID env var. */
function resolveClusterId(args) {
  const id = args?.cluster_id || process.env.YC_SPARK_CLUSTER_ID
  if (!id) {
    throw new Error(
      "cluster_id is required (pass it as an argument or set the YC_SPARK_CLUSTER_ID environment variable)",
    )
  }
  return id
}

// ---------------------------------------------------------------------------
// DLP RPC API (Spark Connect jobs live behind the lakehouse gateway — the raw
// `yc managed-spark job ...` API answers Permission denied for DLP clusters)
// ---------------------------------------------------------------------------

const DLP_API_BASE = {
  prod: "https://api.datalens.tech",
  preprod: "https://api.preprod.datalens.tech",
}

function dlpTokenArgs(environment) {
  return environment === "preprod"
    ? ["--profile", "sandbox-preprod", "iam", "create-token"]
    : ["iam", "create-token"]
}

async function dlpRpc(environment, method, orgId, body) {
  const base = DLP_API_BASE[environment]
  if (!base) throw new Error(`unknown environment: ${environment} (use "prod" or "preprod")`)
  const org = orgId || process.env.DLP_ORG_ID
  if (!org) {
    throw new Error(
      "org_id is required (pass it as an argument or set the DLP_ORG_ID environment variable)",
    )
  }
  const token = (await runYc(dlpTokenArgs(environment))).trim()
  const res = await fetch(`${base}/rpc/${method}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "x-dl-api-version": "3",
      "x-dl-org-id": org,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`DLP RPC ${method} -> HTTP ${res.status}: ${text.trim().slice(0, 500)}`)
  return text
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "create_spark_connection",
    description:
      "Create a Spark Connect session (a SparkConnect job) on a DLP Spark cluster via the DLP RPC " +
      "API (POST /rpc/createSparkJob, variant sparkConnectJob). cluster_id is the DLP SparkCluster " +
      "id (b6p..., field 'id' of list_spark_clusters) — NOT the YC managed cluster id. Returns the " +
      "created job or an async LakehouseOperation (poll with get_lakehouse_operation of the " +
      "dlp-api server); read connectUrl via list_spark_jobs.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: {
          type: "string",
          description: "DLP SparkCluster id (b6p...). Falls back to the YC_SPARK_CLUSTER_ID env var.",
        },
        name: { type: "string", description: "Optional job name ([a-z][-a-z0-9]{1,62}[a-z0-9])." },
        catalogs: {
          type: "array",
          items: { type: "string" },
          description: "Optional REST catalog ids (from list_catalogs) to attach to the job.",
        },
        environment: { type: "string", description: 'DLP environment: "prod" (default) or "preprod".' },
        org_id: { type: "string", description: "Organization id (x-dl-org-id). Falls back to the DLP_ORG_ID env var." },
      },
    },
    run: async (args) => {
      const cluster = resolveClusterId(args)
      const body = { clusterId: String(cluster), sparkConnectJob: {} }
      if (args?.name) body.name = String(args.name)
      if (Array.isArray(args?.catalogs) && args.catalogs.length) {
        body.catalogs = args.catalogs.map((id) => ({ catalogId: String(id) }))
      }
      return dlpRpc(args?.environment || "prod", "createSparkJob", args?.org_id, body)
    },
  },
  {
    name: "list_spark_jobs",
    description:
      "List Spark jobs on a DLP Spark cluster via the DLP RPC API (POST /rpc/listSparkJobs). " +
      "cluster_id is the DLP SparkCluster id (b6p...). Use it to find the running job, its status " +
      "and its connectUrl (e.g. sc://...:443) for building a PySpark session.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: {
          type: "string",
          description: "DLP SparkCluster id (b6p...). Falls back to the YC_SPARK_CLUSTER_ID env var.",
        },
        page_size: { type: "integer", description: "Max jobs to return (default 100)." },
        page_token: { type: "string", description: "Token for the next page." },
        environment: { type: "string", description: 'DLP environment: "prod" (default) or "preprod".' },
        org_id: { type: "string", description: "Organization id (x-dl-org-id). Falls back to the DLP_ORG_ID env var." },
      },
    },
    run: async (args) => {
      const cluster = resolveClusterId(args)
      const body = { clusterId: String(cluster) }
      if (args?.page_size != null) body.pageSize = Number(args.page_size)
      if (args?.page_token) body.pageToken = String(args.page_token)
      return dlpRpc(args?.environment || "prod", "listSparkJobs", args?.org_id, body)
    },
  },
  {
    name: "cancel_spark_connection",
    description:
      "Cancel (shut down) a SparkConnect job on a DLP Spark cluster via the DLP RPC API " +
      "(POST /rpc/cancelSparkJob). cluster_id is the DLP SparkCluster id (b6p...). Jobs in ERROR, " +
      "DONE, or CANCELLED status cannot be cancelled.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: {
          type: "string",
          description: "DLP SparkCluster id (b6p...). Falls back to the YC_SPARK_CLUSTER_ID env var.",
        },
        job_id: { type: "string", description: "Id of the SparkConnect job to cancel." },
        environment: { type: "string", description: 'DLP environment: "prod" (default) or "preprod".' },
        org_id: { type: "string", description: "Organization id (x-dl-org-id). Falls back to the DLP_ORG_ID env var." },
      },
      required: ["job_id"],
    },
    run: async (args) => {
      const cluster = resolveClusterId(args)
      if (!args?.job_id) throw new Error("job_id is required")
      return dlpRpc(args?.environment || "prod", "cancelSparkJob", args?.org_id, {
        clusterId: String(cluster),
        jobId: String(args.job_id),
      })
    },
  },
]

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

// ---------------------------------------------------------------------------
// MCP stdio protocol (newline-delimited JSON-RPC 2.0)
// ---------------------------------------------------------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n")
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } })
}

async function handleToolCall(id, params) {
  const tool = TOOL_BY_NAME.get(params?.name)
  if (!tool) {
    logLine(`call ${params?.name} -> unknown tool`)
    replyError(id, -32602, `unknown tool: ${params?.name}`)
    return
  }
  // Log tool name + non-secret identifiers only (never connect_url / token).
  const a = params?.arguments || {}
  const ctx = [
    a.cluster_id && `cluster=${a.cluster_id}`,
    a.job_id && `job=${a.job_id}`,
    a.environment && `env=${a.environment}`,
    a.name && `name=${a.name}`,
  ]
    .filter(Boolean)
    .join(" ")
  logLine(`call ${params.name}${ctx ? " " + ctx : ""}`)
  try {
    const out = await tool.run(a)
    logLine(`ok   ${params.name}`)
    reply(id, { content: [{ type: "text", text: out.trim() || "(empty response)" }] })
  } catch (err) {
    // Surface failures to the model as tool errors rather than crashing the server.
    logLine(`err  ${params.name}: ${err.message}`)
    reply(id, { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true })
  }
}

async function handle(msg) {
  const { id, method, params } = msg
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "spark-connect", version: "0.1.0" },
      })
      return
    case "notifications/initialized":
      return // notification, no response
    case "tools/list":
      reply(
        id,
        { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
      )
      return
    case "tools/call":
      await handleToolCall(id, params)
      return
    case "ping":
      reply(id, {})
      return
    default:
      if (id !== undefined) replyError(id, -32601, `method not found: ${method}`)
  }
}

const rl = createInterface({ input: process.stdin })
rl.on("line", (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return // ignore non-JSON lines
  }
  handle(msg).catch((err) => {
    if (msg && msg.id !== undefined) replyError(msg.id, -32603, `internal error: ${err.message}`)
  })
})
