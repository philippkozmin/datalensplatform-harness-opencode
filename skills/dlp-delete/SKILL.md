---
name: dlp-delete
description: MANDATORY skill for ANY destructive DLP operation — deleting / removing Spark clusters, Trino clusters, REST catalogs (Iceberg), collections, Spark jobs / SparkConnect sessions, SQL scripts, or any other DataLens Platform object (удаление, удалить, delete, remove, purge, teardown, чистка кластеров). Enforces the confirmation gate: objects NOT created within the current session must be explicitly confirmed by the user before deletion. Load this skill before issuing any delete RPC or cancel call.
---

# dlp-delete — guarded deletion of DLP objects

## Purpose

Every destructive operation against DataLens Platform (delete a cluster, catalog, collection,
job, script, …) goes through this skill. Its single most important rule is the **confirmation
gate** for pre-existing objects.

## MANDATORY — confirmation gate

> **Before deleting an object that was NOT created within the current session, you MUST ask the
> user for explicit confirmation and receive it. No exceptions.**

- "Not created in the current session" = the object already existed when the session started
  (seen in `memory/infrastructure.md`, or listed via an RPC, or older than the session).
- Ask with the `question` tool (or in plain chat if the tool is unavailable), presenting for
  EVERY object to be deleted:
  - object **type** (Spark cluster / Trino cluster / catalog / collection / job / script / …),
  - **name** AND **id** as resolved from the API,
  - **status** and, when available, `createdAt` / `createdBy`.
- Only after an explicit confirmation proceed. A vague or partial "да" to a batch list is NOT
  enough when the actual resolved set differs from what the user named — re-confirm the resolved
  set (e.g. the user said "‑8 по ‑3" but ‑5 does not exist: show the exact 4-object list).
- Objects **created in the current session** may be deleted without an extra gate when the user
  asks for it — the creation context is already known and user-owned.
- Never delete anything "along the way": cascades, "similar old things", leftovers — each object
  goes through the gate.
- Batch deletions: confirm the full explicit list **once**, then delete exactly the confirmed
  objects, nothing more.

## Workflow

1. **Resolve.** Find every target object via the listing RPC first (`listSparkClusters`,
   `listTrinoClusters`, `listCatalogs`, …) — names → ids, check current status. Never guess ids
   from memory alone; re-list to verify.
2. **Confirm** (see the gate above) with the resolved list.
3. **Delete** via the DLP RPC (`/rpc/deleteSparkCluster`, `/rpc/deleteTrinoCluster`, catalog
   deletion, `cancelSparkJob` for jobs, …). Headers: `Authorization: Bearer <IAM>`,
   `x-dl-api-version: 3`, `x-dl-org-id`. Base URL and token source per environment
   (prod/preprod — see `dlp-preprod` and `memory/infrastructure.md`).
4. **Poll.** Deletions are asynchronous: each returns a `LakehouseOperation`. Poll
   `/rpc/getLakehouseOperation` with `{"operationId": "<id>"}` (field is `operationId`, not
   `id`) until `done=true`; check `error` on completion. Poll every ~20 s; cluster deletion can
   take minutes.
5. **Verify.** Re-list the object type and confirm the objects are gone.
6. **Record.** Append what was deleted (ids, names, operations) to the session's
   `side-cars/log.md` and update `memory/infrastructure.md` when it references deleted objects.

## Notes

- Clusters in `ERROR` or `CREATING` status can also be deleted — do not assume they are
  untouchable; they still go through the gate.
- If a delete operation fails, report the error to the user; do not silently retry.
- zsh on macOS has no `mapfile`: poll operation ids from a file with a plain `while read` loop.
