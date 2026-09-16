---
name: dlp-preprod
description: "Preprod environment override for DataLens Platform (DLP) work. Load when the user explicitly says they are working on preprod / препрод / pre-prod / preproduction / sandbox-preprod / preprod.datalens.ru, or asks for DLP actions against the preproduction environment. It overrides the IAM token source (yc --profile sandbox-preprod iam create-token instead of the get_iam_token tool) and the DLP API base URL (https://preprod.datalens.ru/ instead of https://datalens.ru/). Use ONLY on an explicit preprod request; the default is production and existing skills stay unchanged."
---

# DLP preprod environment

Two DLP environments exist. Pick strictly by what the user said:

|                        | Production (default)                          | Preprod                                            |
| ---------------------- | --------------------------------------------- | -------------------------------------------------- |
| IAM token              | `get_iam_token` tool (`yc iam create-token`)  | `yc --profile sandbox-preprod iam create-token`    |
| DLP API base URL       | `https://datalens.ru/`                        | `https://preprod.datalens.ru/`                     |

## When in preprod mode (explicit "preprod" / "препрод" from the user)

Overrides Step 1 of `main_orchestration` and Step 1 of `sparkconnect`; everything else
(session id, memory, side-cars, engineer/scheduler routing, Spark Connect flow, teardown
rules) works exactly as in the existing skills.

1. **IAM token — do NOT use the `get_iam_token` tool** (it runs plain `yc iam create-token`,
   i.e. production credentials). Instead run in Bash:

   ```
   yc --profile sandbox-preprod iam create-token
   ```

   Use the result as `Authorization: Bearer <token>`. Same rules as always: valid for at
   most 12 hours, refresh on long sessions / auth errors, never write the token into
   side-cars files.

2. **API base URL** — use `https://preprod.datalens.ru/` everywhere a DLP API address is
   needed, in place of `https://datalens.ru/`.

   For the DLP RPC API (`runSqlQuery` via the `dlp-api` MCP tool) pass
   `environment: "preprod"` → `https://api.preprod.datalens.tech` (prod default:
   `environment: "prod"` / omit → `https://api.datalens.tech`).

3. **Propagate to subagents** — in every `engineer` / `scheduler` task brief, state the
   environment explicitly: `environment: preprod`, the exact token command above, and the
   `https://preprod.datalens.ru/` base URL, so a subagent does not fall back to prod defaults.

## When NOT in preprod mode

If the user did not explicitly indicate preprod, they are on **production**: keep the
default behavior of `main_orchestration` / `sparkconnect` completely unchanged —
`get_iam_token` tool for tokens, `https://datalens.ru/` as the API base URL. If it is
ambiguous which environment is meant, ask the user before making any API call.
