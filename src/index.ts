import type { Plugin } from "@opencode-ai/plugin"
import { fileURLToPath, pathToFileURL } from "node:url"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { existsSync } from "node:fs"
import { copyFile, cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { applyEdits, modify, parse } from "jsonc-parser"

const HERE = dirname(fileURLToPath(import.meta.url))
// OpenCode source files (skills/, agents/, tools/, AGENTS.md, mcp/) live one level up, at the repo root.
const SOURCES = join(HERE, "..")

/** Resolve the OpenCode global config dir the same way OpenCode does. */
function configDir(): string {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg) return join(xdg, "opencode")
  return join(homedir(), ".config", "opencode")
}
const CONFIG_DIR = configDir()

/** Global config file precedence — mirrors OpenCode's `globalConfigFile()` exactly. */
const GLOBAL_CONFIG_CANDIDATES = ["opencode.jsonc", "opencode.json", "config.json"]
/** Marker used to recognize (and refresh) our own entries in `config.instructions`. */
const AGENTS_MARKER = "datalens-harness/AGENTS.md"
const FORMAT_OPTIONS = { insertSpaces: true, tabSize: 2 }

function globalConfigFile(): string {
  for (const name of GLOBAL_CONFIG_CANDIDATES) {
    const f = join(CONFIG_DIR, name)
    if (existsSync(f)) return f
  }
  return join(CONFIG_DIR, GLOBAL_CONFIG_CANDIDATES[0]) // default when none exists: opencode.jsonc
}

/**
 * Register tools natively by importing each standalone file in tools/ at load.
 * The tool definitions (`export default tool({...})`) live in their own files — no tool
 * logic is inlined here. Returned in the plugin `tool` map, they are available immediately
 * in the session. The files are ALSO copied to the config dir by bootstrap("tools") so they
 * exist as standalone custom tools as well (same definition either way).
 */
async function loadTools(): Promise<Record<string, unknown>> {
  const dir = join(SOURCES, "tools")
  const out: Record<string, unknown> = {}
  let files: string[] = []
  try {
    files = await readdir(dir)
  } catch {
    return out
  }
  for (const file of files) {
    if (!/\.(ts|js|mjs)$/.test(file)) continue
    const name = file.replace(/\.(ts|js|mjs)$/, "")
    const mod = await import(pathToFileURL(join(dir, file)).href)
    if (mod?.default) out[name] = mod.default
  }
  return out
}

/**
 * Copy a source tree into the user's global OpenCode config.
 * Overwrites existing files with the shipped versions on every load (force: true) so the
 * canonical versions always win. (There is no plugin API to register skills/agents.)
 */
async function bootstrap(sub: string): Promise<void> {
  const src = join(SOURCES, sub)
  const dest = join(CONFIG_DIR, sub)
  await mkdir(dest, { recursive: true })
  await cp(src, dest, { recursive: true, force: true })
}

/**
 * Copy the shipped AGENTS.md to a stable, harness-owned path under the config dir and return
 * that absolute path. Delivered to the model via `config.instructions` (written below) — read
 * every turn, so it is the file-based carrier of the main_orchestration-first mandate. We never
 * touch the user's own ~/.config/opencode/AGENTS.md (different path).
 */
async function copyAgentMd(): Promise<string> {
  const destDir = join(CONFIG_DIR, "datalens-harness")
  await mkdir(destDir, { recursive: true })
  const dest = join(destDir, "AGENTS.md")
  await copyFile(join(SOURCES, "AGENTS.md"), dest)
  return dest
}

/**
 * Idempotently merge the harness defaults into the user's GLOBAL opencode.json:
 *   - mcp.spark-connect        — only if the user hasn't configured it (their override, incl.
 *                                `{ "enabled": false }`, always wins).
 *   - permission.skill.main_orchestration = "allow" — only if the user has no explicit rule.
 *   - instructions += <config-dir>/datalens-harness/AGENTS.md — cleans stale datalens entries
 *                                (covers paths from older harness versions) and adds ours.
 *
 * Written via direct fs + jsonc-parser (comment-safe; the same lib OpenCode uses). This is NOT
 * done through the SDK: the SDK has no global-config write, and `PATCH /config` disposes the
 * running instance (a restart loop). The write is startup-time and persists for the NEXT restart;
 * the running session keeps its already-loaded config, so a one-time restart after install is
 * expected (documented in the README). Errors are swallowed so they can never break plugin load.
 */
async function ensureGlobalConfig(agentMdPath: string): Promise<void> {
  const file = globalConfigFile()
  let text = "{}"
  try {
    const read = await readFile(file, "utf8")
    text = read && read.trim() ? read : "{}"
  } catch {
    // file absent → start from empty object; we'll create it below
  }

  let obj: Record<string, unknown> = {}
  try {
    const parsed = parse(text)
    obj = parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    obj = {}
  }

  type Op = { path: (string | number)[]; value: unknown }
  const ops: Op[] = []

  // mcp.spark-connect — only if the user hasn't configured it.
  const mcp = obj.mcp && typeof obj.mcp === "object" ? (obj.mcp as Record<string, unknown>) : {}
  if (!mcp["spark-connect"]) {
    ops.push({
      path: ["mcp", "spark-connect"],
      value: {
        type: "local",
        command: ["node", join(SOURCES, "mcp", "spark-connect", "server.mjs")],
      },
    })
  }

  // permission.skill.main_orchestration — only if the user has no explicit rule for it.
  const perm = obj.permission && typeof obj.permission === "object" ? (obj.permission as Record<string, unknown>) : {}
  const skill = perm.skill && typeof perm.skill === "object" ? (perm.skill as Record<string, unknown>) : null
  if (!skill || !("main_orchestration" in skill)) {
    ops.push({ path: ["permission", "skill", "main_orchestration"], value: "allow" })
  }

  // instructions — drop stale datalens entries, add ours if missing.
  const currentInstr: string[] = Array.isArray(obj.instructions)
    ? obj.instructions.filter((p): p is string => typeof p === "string")
    : []
  const cleaned = currentInstr.filter((p) => !p.includes(AGENTS_MARKER))
  if (!cleaned.includes(agentMdPath)) cleaned.push(agentMdPath)
  const unchanged =
    cleaned.length === currentInstr.length && currentInstr.every((p, i) => p === cleaned[i])
  if (!unchanged) {
    ops.push({ path: ["instructions"], value: cleaned })
  }

  if (ops.length === 0) return

  let result = text
  for (const op of ops) {
    const edits = modify(result, op.path, op.value, { formattingOptions: FORMAT_OPTIONS })
    result = applyEdits(result, edits)
  }
  if (result !== text) {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, result, "utf8")
  }
}

/**
 * DataLens Platform harness loader.
 *
 * Zero runtime hooks. On load it:
 *  - copies skills/agents/tools into ~/.config/opencode/{skills,agents,tools} (file-based,
 *    survives restart; there is no plugin API to register skills/agents);
 *  - copies AGENTS.md to ~/.config/opencode/datalens-harness/AGENTS.md;
 *  - idempotently merges mcp/permission/instructions into the user's GLOBAL opencode.json
 *    (direct fs + jsonc-parser, comment-safe, respecting existing user keys);
 *  - registers the native tools (get_iam_token, get_harness_session_id) via the `tool` map.
 *
 * Everything behavioural lives in files (opencode.json + copied skills/agents/AGENTS.md), so the
 * harness is stable after a restart. A one-time restart after the first install is expected,
 * because the running session has already loaded its config before this write.
 */
export const DatalensHarness: Plugin = async () => {
  try {
    await bootstrap("tools")
    await bootstrap("skills")
    await bootstrap("agents")
    const agentMdPath = await copyAgentMd()
    await ensureGlobalConfig(agentMdPath)
  } catch (err) {
    console.error("[datalens-harness] bootstrap / global config write failed:", err)
  }

  let tool: Record<string, unknown> = {}
  try {
    tool = await loadTools()
  } catch (err) {
    console.error("[datalens-harness] loading tools failed:", err)
  }

  return { tool }
}
