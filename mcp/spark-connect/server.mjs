#!/usr/bin/env node
/**
 * spark-connect — zero-dependency MCP stdio server for Yandex Managed Spark "Spark Connect".
 *
 * In Managed Spark, a Spark Connect session is a SparkConnect *job* on a cluster. This server
 * manages that job's lifecycle by shelling out to the `yc` CLI (which authenticates itself):
 *
 *   - create_spark_connection : yc managed-spark job create-spark-connect
 *   - list_spark_jobs         : yc managed-spark job list
 *   - cancel_spark_connection : yc managed-spark job cancel
 *
 * It does NOT assemble the connect URI or hold a session — building a PySpark SparkSession from
 * the job's connect_url + an IAM token is described in the `sparkconnect` skill.
 *
 * Protocol: minimal MCP over stdio (newline-delimited JSON-RPC 2.0): initialize, tools/list,
 * tools/call. No external dependencies — runs with plain `node`.
 *
 * Docs: https://yandex.cloud/en/docs/managed-spark/operations/jobs-sparkconnect
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

/** Resolve the cluster id from the tool arg or the YC_SPARK_CLUSTER_ID env var. */
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
// Tools
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "create_spark_connection",
    description:
      "Create a Spark Connect session (a SparkConnect job) on a Yandex Managed Spark cluster. " +
      "Returns the created job (id, status, and connect_url if already available). Use list_spark_jobs " +
      "afterwards to read the connect_url once the job is running.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: {
          type: "string",
          description: "Managed Spark cluster id. Falls back to the YC_SPARK_CLUSTER_ID env var.",
        },
        name: { type: "string", description: "Optional name for the SparkConnect job." },
      },
    },
    run: async (args) => {
      const cluster = resolveClusterId(args)
      const cmd = ["managed-spark", "job", "create-spark-connect", "--cluster-id", cluster]
      if (args?.name) cmd.push("--name", String(args.name))
      cmd.push("--format", "json")
      return runYc(cmd)
    },
  },
  {
    name: "list_spark_jobs",
    description:
      "List jobs on a Yandex Managed Spark cluster (including SparkConnect jobs). Use it to find the " +
      "running job, its status, and its connect_url (e.g. sc://...:443) for building a PySpark session.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: {
          type: "string",
          description: "Managed Spark cluster id. Falls back to the YC_SPARK_CLUSTER_ID env var.",
        },
      },
    },
    run: async (args) => {
      const cluster = resolveClusterId(args)
      return runYc(["managed-spark", "job", "list", "--cluster-id", cluster, "--format", "json"])
    },
  },
  {
    name: "cancel_spark_connection",
    description:
      "Cancel (shut down) a SparkConnect job on a Yandex Managed Spark cluster. Jobs in ERROR, DONE, " +
      "or CANCELLED status cannot be cancelled.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: {
          type: "string",
          description: "Managed Spark cluster id. Falls back to the YC_SPARK_CLUSTER_ID env var.",
        },
        job_id: { type: "string", description: "Id of the SparkConnect job to cancel." },
      },
      required: ["job_id"],
    },
    run: async (args) => {
      const cluster = resolveClusterId(args)
      if (!args?.job_id) throw new Error("job_id is required")
      return runYc([
        "managed-spark", "job", "cancel", String(args.job_id),
        "--cluster-id", cluster, "--format", "json",
      ])
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
  const ctx = [a.cluster_id && `cluster=${a.cluster_id}`, a.job_id && `job=${a.job_id}`]
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
