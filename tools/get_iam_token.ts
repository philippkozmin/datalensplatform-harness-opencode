import { tool } from "@opencode-ai/plugin"
import { join } from "node:path"
import { mkdirSync, appendFileSync } from "node:fs"

/**
 * Get a Yandex Cloud IAM token via the yc CLI (`yc iam create-token`).
 *
 * Standalone OpenCode custom tool. The filename (get_iam_token) becomes the tool name.
 * Requires the `yc` CLI to be installed and authenticated as a user.
 * An IAM token is valid for at most 12 hours. Use it as `Authorization: Bearer <token>`.
 * Docs: https://yandex.cloud/en/docs/iam/operations/iam-token/create
 *
 * Side-cars logging is best-effort and never writes the token itself — only a timestamped
 * line (requested / ok / failed) appended to <worktree>/side-cars/<sessionID>/logs/get_iam_token.log.
 */
function logSidecar(context: { sessionID: string; worktree: string }, msg: string): void {
  try {
    const dir = join(context.worktree, "side-cars", context.sessionID, "logs")
    mkdirSync(dir, { recursive: true })
    const ts = new Date().toISOString()
    appendFileSync(join(dir, "get_iam_token.log"), `${ts} ${msg}\n`)
  } catch {
    // best-effort: never let logging break token issuance
  }
}

export default tool({
  description:
    "Get a Yandex Cloud IAM token (via the yc CLI) for authenticating requests to Yandex Cloud / DataLens APIs. " +
    "Returns the raw IAM token; use it as an 'Authorization: Bearer <token>' header. Valid for up to 12 hours.",
  args: {},
  async execute(_args, context) {
    try {
      logSidecar(context, "requesting IAM token via 'yc iam create-token'")
      const { $ } = await import("bun")
      const token = (await $`yc iam create-token`.text()).trim()
      if (!token) {
        logSidecar(context, "FAILED: 'yc iam create-token' returned nothing")
        return "Failed to get IAM token: 'yc iam create-token' returned nothing."
      }
      logSidecar(context, "token issued OK")
      return token
    } catch (err) {
      logSidecar(context, `FAILED: ${err instanceof Error ? err.message : String(err)}`)
      return (
        "Could not get an IAM token. Install and authenticate the 'yc' CLI. " +
        `Details: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  },
})
