#!/usr/bin/env node
/**
 * dlp-api — zero-dependency MCP stdio server for the DataLens Platform (DLP) public API.
 *
 * Tools:
 *
 *   - run_sql_query : POST {base}/rpc/runSqlQuery
 *       headers: x-dl-org-id, x-dl-api-version: 3, authorization: Bearer <IAM token>
 *       body:    { sqlQueryId, params? }
 *
 *   - list_catalogs : POST {base}/rpc/listCatalogs
 *       headers: x-dl-org-id, x-dl-api-version: 3, authorization: Bearer <IAM token>
 *       body:    { pageSize?, pageToken? }
 *
 *   - get_api_spec : GET {base}/json/ — the public OpenAPI 3.1 spec (optional path_filter)
 *
 *   - list_spark_clusters : POST {base}/rpc/listSparkClusters
 *       body: { pageSize?, pageToken?, filter? }
 *
 *   - create_spark_cluster : POST {base}/rpc/createSparkCluster
 *       body: { collectionId, cloudEnvironmentId, name, description?, labels?,
 *               config: { sparkVersion?, resourcePools: {driver, executor},
 *                         dependencies?, logging? } }
 *       returns an async LakehouseOperation — poll with get_lakehouse_operation
 *
 *   - get_lakehouse_operation : POST {base}/rpc/getLakehouseOperation
 *       body: { operationId }
 *
 * The IAM token is NOT fetched here — obtain a fresh one with the `get_iam_token` tool
 * (or `yc iam create-token`) and pass it per call (or via the DLP_IAM_TOKEN env var).
 * The org id comes from the org_id argument or the DLP_ORG_ID env var.
 *
 * Target environment — pass `environment: "prod" | "preprod"` per call (default prod):
 *   prod    → https://api.datalens.tech
 *   preprod → https://api.preprod.datalens.tech
 * The choice comes from the session context: when the user says they are working on
 * preprod, the model passes environment=preprod (and uses the sandbox-preprod yc
 * profile for the token). Precedence: base_url arg > environment arg > DLP_ENVIRONMENT
 * env > DLP_API_BASE_URL env > prod default.
 *
 * Protocol: minimal MCP over stdio (newline-delimited JSON-RPC 2.0): initialize,
 * tools/list, tools/call. No external dependencies — runs with plain `node` (>= 18,
 * global fetch).
 *
 * ---------------------------------------------------------------------------
 * Side-cars logging (OpenCode)
 *
 * Unlike Claude Code, OpenCode does not inject a session id into MCP server processes — a local
 * MCP server is spawned once and shared across all sessions. So logging here is project-scoped:
 * it writes to `<process.cwd()>/side-cars/dlp-api.log` (project root). If the deployer sets
 * OPENCODE_SESSION_ID (or the legacy CLAUDE_SESSION_ID) in the MCP `environment`, the log is
 * session-scoped instead: `<project>/side-cars/<session>/logs/dlp-api.log`.
 *
 * The project root is `process.cwd()` (OpenCode spawns the server with cwd = project dir).
 * Logging is strictly best-effort: any failure is swallowed so it can never break a tool call.
 * Secrets (IAM token, param values) are NEVER logged — only tool name, environment, org id,
 * sql query id, and status/error text.
 * ---------------------------------------------------------------------------
 */
import { createInterface } from "node:readline"
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const PROTOCOL_VERSION = "2024-11-05"
const ENVIRONMENTS = {
  prod: "https://api.datalens.tech",
  preprod: "https://api.preprod.datalens.tech",
}
const DEFAULT_TIMEOUT_MS = 300_000

function sessionId() {
  return process.env.OPENCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || ""
}

function logTarget() {
  const project = process.cwd()
  if (!project) return null
  const session = sessionId()
  if (session) return { dir: join(project, "side-cars", session, "logs"), file: "dlp-api.log" }
  return { dir: join(project, "side-cars"), file: "dlp-api.log" }
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
// Helpers
// ---------------------------------------------------------------------------

function requiredArg(value, name, envVar) {
  if (value) return String(value)
  const fromEnv = envVar && process.env[envVar]
  if (fromEnv) return fromEnv
  throw new Error(`${name} is required (pass it as an argument or set the ${envVar} environment variable)`)
}

function baseUrl(args) {
  if (args?.base_url) return String(args.base_url).replace(/\/+$/, "")
  const envName = String(args?.environment || process.env.DLP_ENVIRONMENT || "prod").toLowerCase()
  const url = ENVIRONMENTS[envName]
  if (!url) {
    throw new Error(`unknown environment '${envName}': expected one of ${Object.keys(ENVIRONMENTS).join(", ")}`)
  }
  return String(process.env.DLP_API_BASE_URL && envName === "prod" && !args?.environment
    ? process.env.DLP_API_BASE_URL
    : url).replace(/\/+$/, "")
}

/**
 * Validate params: an object of name -> string | number | boolean | null.
 * `undefined` entries are dropped. Returns undefined when no params are given.
 */
function normalizeParams(params) {
  if (params === undefined || params === null) return undefined
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new Error("params must be an object of name -> string | number | boolean | null")
  }
  const out = {}
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(`params.${key}: expected string | number | boolean | null, got ${typeof value}`)
    }
    out[key] = value
  }
  return out
}

/** GET a DLP API endpoint (no auth headers — the OpenAPI spec at /json/ is public). */
async function getDlp(url) {
  const timeoutMs = Number(process.env.DLP_API_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res
  try {
    res = await fetch(url, { method: "GET", signal: controller.signal })
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`request timed out after ${timeoutMs} ms (override with DLP_API_TIMEOUT_MS)`)
    }
    throw new Error(`request to ${url} failed: ${err.message}`)
  } finally {
    clearTimeout(timer)
  }
  const text = (await res.text()).trim()
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text || "(empty response body)"}`)
  }
  return text
}

/** POST JSON to the DLP API and resolve the response body text. */
async function callDlp({ url, orgId, token, body }) {
  const timeoutMs = Number(process.env.DLP_API_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dl-org-id": orgId,
        "x-dl-api-version": "3",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`request timed out after ${timeoutMs} ms (override with DLP_API_TIMEOUT_MS)`)
    }
    throw new Error(`request to ${url} failed: ${err.message}`)
  } finally {
    clearTimeout(timer)
  }
  const text = (await res.text()).trim()
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text || "(empty response body)"}`)
  }
  return text
}

/**
 * Build a createSparkCluster resourcePool body from flat args:
 *   { resource_preset_id, fixed_size }                        -> fixedScale
 *   { resource_preset_id, min_size, max_size, initial_size }  -> autoScale
 */
function buildResourcePool(args, role) {
  const preset = args?.[`${role}_resource_preset_id`]
  if (!preset) throw new Error(`${role}_resource_preset_id is required`)
  const pool = { resourcePresetId: String(preset) }
  if (args?.[`${role}_fixed_size`] != null) {
    pool.scalePolicy = { fixedScale: { size: String(args[`${role}_fixed_size`]) } }
  } else if (args?.[`${role}_min_size`] != null || args?.[`${role}_max_size`] != null) {
    const min = args[`${role}_min_size`] ?? 1
    const max = args[`${role}_max_size`] ?? min
    pool.scalePolicy = {
      autoScale: { minSize: String(min), maxSize: String(max), initialSize: String(args?.[`${role}_initial_size`] ?? min) },
    }
  } else {
    throw new Error(`${role}: pass either ${role}_fixed_size or ${role}_min_size/${role}_max_size`)
  }
  return pool
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "run_sql_query",
    description:
      "Run a saved DLP SQL query by id via the DataLens Platform API " +
      "(POST /rpc/runSqlQuery, x-dl-api-version 3). Returns the raw JSON response. " +
      "Pass a fresh IAM token (get_iam_token tool / yc iam create-token) and the org id. " +
      "Select the environment with 'environment': prod → https://api.datalens.tech (default), " +
      "preprod → https://api.preprod.datalens.tech — pass environment=preprod whenever the " +
      "user says they are working on preprod / sandbox-preprod.",
    inputSchema: {
      type: "object",
      properties: {
        iam_token: {
          type: "string",
          description:
            "Yandex Cloud IAM token (Bearer). Falls back to the DLP_IAM_TOKEN env var. " +
            "Valid for at most 12 hours.",
        },
        org_id: {
          type: "string",
          description: "DLP organization id (x-dl-org-id). Falls back to the DLP_ORG_ID env var.",
        },
        sql_query_id: { type: "string", description: "Id of the saved SQL query to run." },
        environment: {
          type: "string",
          enum: ["prod", "preprod"],
          description:
            "Target DLP environment by the user's session context: " +
            "'prod' → https://api.datalens.tech (default), " +
            "'preprod' → https://api.preprod.datalens.tech.",
        },
        params: {
          type: "object",
          description:
            "Optional query parameters: name -> string | number | boolean | null.",
          additionalProperties: { type: ["string", "number", "boolean", "null"] },
        },
        base_url: {
          type: "string",
          description:
            "Explicit API base URL override (wins over 'environment'). Rarely needed.",
        },
      },
      required: ["sql_query_id"],
    },
    run: async (args) => {
      const orgId = requiredArg(args?.org_id, "org_id", "DLP_ORG_ID")
      const token = requiredArg(args?.iam_token, "iam_token", "DLP_IAM_TOKEN")
      if (!args?.sql_query_id) throw new Error("sql_query_id is required")
      const body = { sqlQueryId: String(args.sql_query_id) }
      const params = normalizeParams(args?.params)
      if (params) body.params = params
      return callDlp({
        url: `${baseUrl(args)}/rpc/runSqlQuery`,
        orgId,
        token,
        body,
      })
    },
  },
  {
    name: "list_catalogs",
    description:
      "List the org's REST catalogs (lakehouse/Iceberg) via the DataLens Platform API " +
      "(POST /rpc/listCatalogs, x-dl-api-version 3). Returns the raw JSON response with each " +
      "catalog's id, name, cloudEnvironmentId and bucket settings. " +
      "Pass a fresh IAM token (get_iam_token tool / yc iam create-token) and the org id. " +
      "Select the environment with 'environment': prod → https://api.datalens.tech (default), " +
      "preprod → https://api.preprod.datalens.tech — pass environment=preprod whenever the " +
      "user says they are working on preprod / sandbox-preprod.",
    inputSchema: {
      type: "object",
      properties: {
        iam_token: {
          type: "string",
          description:
            "Yandex Cloud IAM token (Bearer). Falls back to the DLP_IAM_TOKEN env var. " +
            "Valid for at most 12 hours.",
        },
        org_id: {
          type: "string",
          description: "DLP organization id (x-dl-org-id). Falls back to the DLP_ORG_ID env var.",
        },
        page_size: {
          type: "integer",
          minimum: 0,
          description: "Maximum number of REST catalogs to return. The default is 100.",
        },
        page_token: {
          type: "string",
          description: "Token for the next page of REST catalogs (nextPageToken of the previous response).",
        },
        environment: {
          type: "string",
          enum: ["prod", "preprod"],
          description:
            "Target DLP environment by the user's session context: " +
            "'prod' → https://api.datalens.tech (default), " +
            "'preprod' → https://api.preprod.datalens.tech.",
        },
        base_url: {
          type: "string",
          description:
            "Explicit API base URL override (wins over 'environment'). Rarely needed.",
        },
      },
    },
    run: async (args) => {
      const orgId = requiredArg(args?.org_id, "org_id", "DLP_ORG_ID")
      const token = requiredArg(args?.iam_token, "iam_token", "DLP_IAM_TOKEN")
      const body = {}
      if (args?.page_size != null) {
        const n = Number(args.page_size)
        if (!Number.isInteger(n) || n < 0) {
          throw new Error("page_size must be a non-negative integer")
        }
        body.pageSize = n
      }
      if (args?.page_token) body.pageToken = String(args.page_token)
      return callDlp({
        url: `${baseUrl(args)}/rpc/listCatalogs`,
        orgId,
        token,
        body,
      })
    },
  },
  {
    name: "get_api_spec",
    description:
      "Fetch the DataLens Platform OpenAPI specification (GET /json/, OpenAPI 3.1, ~750 KB — " +
      "strongly prefer path_filter to slim the output). With path_filter (case-insensitive " +
      "substring, e.g. 'SparkCluster', 'Collection') returns info + only the matching paths. " +
      "No auth required. Environment select works as in the other tools.",
    inputSchema: {
      type: "object",
      properties: {
        path_filter: {
          type: "string",
          description: "Case-insensitive substring matched against path names (e.g. 'spark', 'collection').",
        },
        environment: {
          type: "string",
          enum: ["prod", "preprod"],
          description: "Target DLP environment: prod → https://api.datalens.tech (default), preprod → https://api.preprod.datalens.tech.",
        },
        base_url: {
          type: "string",
          description: "Explicit API base URL override (wins over 'environment'). Rarely needed.",
        },
      },
    },
    run: async (args) => {
      const text = await getDlp(`${baseUrl(args)}/json/`)
      const filter = args?.path_filter ? String(args.path_filter).toLowerCase() : ""
      if (!filter) return text
      const spec = JSON.parse(text)
      const paths = {}
      for (const [p, item] of Object.entries(spec.paths || {})) {
        if (p.toLowerCase().includes(filter)) paths[p] = item
      }
      return JSON.stringify({ openapi: spec.openapi, info: spec.info, paths })
    },
  },
  {
    name: "list_spark_clusters",
    description:
      "List Spark clusters available to the DLP org via POST /rpc/listSparkClusters " +
      "(x-dl-api-version 3). Returns clusters with id, clusterId (YC managed), collectionId, " +
      "cloudEnvironmentId, config (sparkVersion, resourcePools, dependencies, logging), health " +
      "(HEALTH_UNKNOWN|ALIVE|DEAD|DEGRADED) and status (CREATING|RUNNING|UPDATING|ERROR|STOPPING|STOPPED|STARTING). " +
      "Pass a fresh IAM token and the org id; environment as in the other tools.",
    inputSchema: {
      type: "object",
      properties: {
        iam_token: {
          type: "string",
          description: "Yandex Cloud IAM token (Bearer). Falls back to the DLP_IAM_TOKEN env var.",
        },
        org_id: { type: "string", description: "DLP organization id (x-dl-org-id). Falls back to the DLP_ORG_ID env var." },
        page_size: { type: "integer", minimum: 0, description: "Maximum number of Spark clusters to return. The default is 100." },
        page_token: { type: "string", description: "Token for the next page of Spark clusters (nextPageToken of the previous response)." },
        filter: {
          type: "array",
          items: { type: "string" },
          description: "Optional filter expressions applied to the Spark cluster list.",
        },
        environment: {
          type: "string",
          enum: ["prod", "preprod"],
          description: "Target DLP environment: prod → https://api.datalens.tech (default), preprod → https://api.preprod.datalens.tech.",
        },
        base_url: { type: "string", description: "Explicit API base URL override (wins over 'environment'). Rarely needed." },
      },
    },
    run: async (args) => {
      const orgId = requiredArg(args?.org_id, "org_id", "DLP_ORG_ID")
      const token = requiredArg(args?.iam_token, "iam_token", "DLP_IAM_TOKEN")
      const body = {}
      if (args?.page_size != null) {
        const n = Number(args.page_size)
        if (!Number.isInteger(n) || n < 0) throw new Error("page_size must be a non-negative integer")
        body.pageSize = n
      }
      if (args?.page_token) body.pageToken = String(args.page_token)
      if (Array.isArray(args?.filter)) body.filter = args.filter.map(String)
      return callDlp({ url: `${baseUrl(args)}/rpc/listSparkClusters`, orgId, token, body })
    },
  },
  {
    name: "create_spark_cluster",
    description:
      "Create a Spark cluster via POST /rpc/createSparkCluster. Returns an asynchronous " +
      "LakehouseOperation — poll it with get_lakehouse_operation (operationId field) until " +
      "done=true (~5 min); the finished Cluster comes in operation.response. NOTE: the gateway " +
      "validates resource presets (e.g. c2-m8 was rejected as 'unsupported driver resource preset'; " +
      "c4-m16 accepted) — there is no API to list supported presets. Use list_spark_clusters on an " +
      "existing cluster to learn a working cloudEnvironmentId.",
    inputSchema: {
      type: "object",
      properties: {
        iam_token: { type: "string", description: "Yandex Cloud IAM token (Bearer). Falls back to the DLP_IAM_TOKEN env var." },
        org_id: { type: "string", description: "DLP organization id (x-dl-org-id). Falls back to the DLP_ORG_ID env var." },
        collection_id: { type: "string", description: "Id of the DLP collection to create the cluster in." },
        cloud_environment_id: { type: "string", description: "Id of the cloud environment (from an existing cluster via list_spark_clusters)." },
        name: { type: "string", description: "Cluster name (<=63 chars, no leading/trailing whitespace)." },
        description: { type: "string", description: "Optional cluster description (<=200 chars)." },
        labels: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Optional labels (values ^[-_0-9a-z]*$, <=63 chars).",
        },
        spark_version: { type: "string", description: "Optional Spark version; the service default is used when omitted." },
        driver_resource_preset_id: { type: "string", description: "Driver resource preset id (e.g. c4-m16)." },
        driver_fixed_size: { type: "integer", minimum: 1, maximum: 100, description: "Driver fixedScale size (use this OR driver_min_size/driver_max_size)." },
        driver_min_size: { type: "integer", minimum: 0, maximum: 100, description: "Driver autoScale minimum." },
        driver_max_size: { type: "integer", minimum: 1, maximum: 100, description: "Driver autoScale maximum." },
        driver_initial_size: { type: "integer", minimum: 0, maximum: 100, description: "Driver autoScale initial size (defaults to min)." },
        executor_resource_preset_id: { type: "string", description: "Executor resource preset id (e.g. c4-m16)." },
        executor_fixed_size: { type: "integer", minimum: 1, maximum: 100, description: "Executor fixedScale size (use this OR executor_min_size/executor_max_size)." },
        executor_min_size: { type: "integer", minimum: 0, maximum: 100, description: "Executor autoScale minimum." },
        executor_max_size: { type: "integer", minimum: 1, maximum: 100, description: "Executor autoScale maximum." },
        executor_initial_size: { type: "integer", minimum: 0, maximum: 100, description: "Executor autoScale initial size (defaults to min)." },
        pip_packages: { type: "array", items: { type: "string" }, description: "Python packages to install in the cluster." },
        deb_packages: { type: "array", items: { type: "string" }, description: "Debian packages to install in the cluster." },
        logging_enabled: { type: "boolean", description: "Whether cluster logging is enabled." },
        environment: {
          type: "string",
          enum: ["prod", "preprod"],
          description: "Target DLP environment: prod → https://api.datalens.tech (default), preprod → https://api.preprod.datalens.tech.",
        },
        base_url: { type: "string", description: "Explicit API base URL override (wins over 'environment'). Rarely needed." },
      },
      required: ["collection_id", "cloud_environment_id", "name", "driver_resource_preset_id", "executor_resource_preset_id"],
    },
    run: async (args) => {
      const orgId = requiredArg(args?.org_id, "org_id", "DLP_ORG_ID")
      const token = requiredArg(args?.iam_token, "iam_token", "DLP_IAM_TOKEN")
      const body = {
        collectionId: String(args.collection_id),
        cloudEnvironmentId: String(args.cloud_environment_id),
        name: String(args.name),
        config: {
          resourcePools: {
            driver: buildResourcePool(args, "driver"),
            executor: buildResourcePool(args, "executor"),
          },
        },
      }
      if (args?.description) body.description = String(args.description)
      if (args?.labels) body.labels = args.labels
      if (args?.spark_version) body.config.sparkVersion = String(args.spark_version)
      const deps = {}
      if (Array.isArray(args?.pip_packages)) deps.pipPackages = args.pip_packages.map(String)
      if (Array.isArray(args?.deb_packages)) deps.debPackages = args.deb_packages.map(String)
      if (deps.pipPackages || deps.debPackages) body.config.dependencies = deps
      if (args?.logging_enabled != null) body.config.logging = { enabled: Boolean(args.logging_enabled) }
      return callDlp({ url: `${baseUrl(args)}/rpc/createSparkCluster`, orgId, token, body })
    },
  },
  {
    name: "get_lakehouse_operation",
    description:
      "Get a lakehouse asynchronous operation (create/delete Spark or Trino cluster, etc.) by id " +
      "via POST /rpc/getLakehouseOperation. NOTE: the request field is 'operationId' (not 'id'). " +
      "Poll until done=true; error (if failed) and response (the finished resource) come inline.",
    inputSchema: {
      type: "object",
      properties: {
        iam_token: { type: "string", description: "Yandex Cloud IAM token (Bearer). Falls back to the DLP_IAM_TOKEN env var." },
        org_id: { type: "string", description: "DLP organization id (x-dl-org-id). Falls back to the DLP_ORG_ID env var." },
        operation_id: { type: "string", description: "Id of the lakehouse operation (create/delete cluster response id)." },
        environment: {
          type: "string",
          enum: ["prod", "preprod"],
          description: "Target DLP environment: prod → https://api.datalens.tech (default), preprod → https://api.preprod.datalens.tech.",
        },
        base_url: { type: "string", description: "Explicit API base URL override (wins over 'environment'). Rarely needed." },
      },
      required: ["operation_id"],
    },
    run: async (args) => {
      const orgId = requiredArg(args?.org_id, "org_id", "DLP_ORG_ID")
      const token = requiredArg(args?.iam_token, "iam_token", "DLP_IAM_TOKEN")
      if (!args?.operation_id) throw new Error("operation_id is required")
      return callDlp({
        url: `${baseUrl(args)}/rpc/getLakehouseOperation`,
        orgId,
        token,
        body: { operationId: String(args.operation_id) },
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
  // Log tool name + non-secret identifiers only (never the token / param values).
  const a = params?.arguments || {}
  const ctx = [
    a.environment && `env=${a.environment}`,
    a.org_id && `org=${a.org_id}`,
    a.sql_query_id && `query=${a.sql_query_id}`,
    a.operation_id && `op=${a.operation_id}`,
    a.name && `name=${a.name}`,
  ]
    .filter(Boolean)
    .join(" ")
  logLine(`call ${params.name}${ctx ? " " + ctx : ""}`)
  try {
    const out = await tool.run(a)
    logLine(`ok   ${params.name}`)
    reply(id, { content: [{ type: "text", text: out || "(empty response)" }] })
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
        serverInfo: { name: "dlp-api", version: "0.1.0" },
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
