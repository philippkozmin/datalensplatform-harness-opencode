import { tool } from "@opencode-ai/plugin"
import { join } from "node:path"

/**
 * get_harness_session_id — resolve the DataLens Platform harness session context for the
 * current agent turn.
 *
 * OpenCode does NOT expose the session id to the LLM (no CLAUDE_SESSION_ID-style env var).
 * The main_orchestration skill needs the session id and the project root to build the
 * side-cars paths it hands to subagents. This tool bridges that gap: it reads the session
 * context from the tool's ToolContext and returns the exact paths to use.
 *
 * The agent calls this FIRST (inside main_orchestration, Step "resolve context") and then
 * embeds the returned absolute paths into every subagent task brief it writes.
 */
export default tool({
  description:
    "Get the DataLens Platform harness session id (and the project directory, git worktree " +
    "root, and the absolute base path for this session's side-cars channel — " +
    "<worktree>/side-cars/<sessionID>). OpenCode does not expose the session id to the model " +
    "otherwise. Call this at the start of main_orchestration to learn the exact paths to write " +
    "task briefs / results / status / logs into.",
  args: {},
  async execute(_args, context) {
    const { sessionID, directory, worktree } = context
    const sidecarsBase = join(worktree, "side-cars", sessionID)
    const logsDir = join(sidecarsBase, "logs")
    return [
      "{",
      `  "sessionID": ${JSON.stringify(sessionID)},`,
      `  "directory": ${JSON.stringify(directory)},`,
      `  "worktree": ${JSON.stringify(worktree)},`,
      `  "sidecarsBase": ${JSON.stringify(sidecarsBase)},`,
      `  "logsDir": ${JSON.stringify(logsDir)}`,
      "}",
      "",
      "Use these exact absolute paths for the side-cars channel:",
      `  task brief   : ${join(sidecarsBase, "<agent>_task.md")}`,
      `  result       : ${join(sidecarsBase, "<agent>_result.md")}`,
      `  status       : ${join(sidecarsBase, "<agent>_status.md")}`,
      `  log          : ${join(sidecarsBase, "log.md")}`,
      `  agent logs   : ${join(logsDir, "<agent>.log")}`,
    ].join("\n")
  },
})
