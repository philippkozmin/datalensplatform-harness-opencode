---
name: iam-whoami
description: Check whom an IAM token belongs to (YC subject id) via `YC_IAM_TOKEN=<token> ycp --profile preprod iam whoami` or the `yc --profile sandbox-preprod iam whoami` fallback. Use when you need to correlate an IAM token with the DLP user id that appears in lakehouse gateway errors ("refresh token is not found for user <id>"), in `createdBy` fields of collections/clusters/operations, or to verify which account a yc profile authenticates before/after a UI login.
---

# iam-whoami — identify the subject of an IAM token

## Purpose

The DLP RPC API and the lakehouse gateway identify the caller by an opaque YC **subject id**
(e.g. `bfbssgqu9ruv9dgadgog`). The same id appears in:

- `createdBy` of collections, catalogs, clusters and `LakehouseOperation`s,
- gateway errors like `refresh token is not found for user "<id>"` (createSparkJob etc.),
- the `yc iam whoami` output for the token used.

This skill answers "does this token belong to the user I think it does?" — essential when
debugging permission / refresh-token issues, or verifying a UI login actually switched accounts.

## How to run

The token is passed via the `YC_IAM_TOKEN` environment variable (never as a CLI argument, never
written to side-cars / files). The profile only supplies the endpoint & context — it does NOT
re-authenticate, the env token wins.

**Preprod cloud (DLP sandbox work):**

```bash
YC_IAM_TOKEN="<token>" ycp --profile preprod iam whoami
# fallback when the `ycp` CLI is not installed (same preprod endpoint via the sandbox profile):
YC_IAM_TOKEN="<token>" yc --profile sandbox-preprod iam whoami
```

**Production cloud:**

```bash
YC_IAM_TOKEN="<token>" yc iam whoami
```

Output: the subject id (a bare string, e.g. `bfbssgqu9ruv9dgadgog`); `--format json` quotes it.

## Interpretation

| Observation | Meaning |
| :---------- | :------ |
| Output id equals the id in a gateway error / `createdBy` | The token's subject IS that DLP user — errors and objects belong to this token's account |
| Different ids after switching tokens/profiles | Different principals (e.g. a human profile vs a service-account key like `dlp-airflow-profile`) |
| `yc iam whoami` fails with auth error | Token expired/invalid — refresh it first |

Notes:

- The subject id → human login mapping (federation SSO) is **not** exposed by the public API
  (`organization-manager user list` shows org users, federation subjects usually are not there or
  are paginated); treat login attribution as inference unless the UI confirms the account.
- Opaque token: it is not a decodable JWT — `whoami` is the only reliable introspection.
- Safe patterns: `TOKEN=$(yc --profile sandbox-preprod iam create-token); YC_IAM_TOKEN="$TOKEN" yc --profile sandbox-preprod iam whoami`
