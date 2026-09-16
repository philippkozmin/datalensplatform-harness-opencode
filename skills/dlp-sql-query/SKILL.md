---
name: dlp-sql-query
description: "Create, update and run saved SQL queries (постоянный SQL запрос / SQL-запрос) in DataLens Platform (DLP) workbooks via the RPC API createSqlQuery / updateSqlQuery / runSqlQuery, including creating a Trino connection to a DLP lakehouse (Iceberg) catalog. Use when the user asks to create a SQL query in a workbook (воркбук), run a saved query by id, or query a lakehouse catalog (e.g. dlback-test-catalog-10) through Trino. MANDATORY: the workbook and the connection must be determined before creating — if either is not determined, ask the user instead of guessing."
---

# DLP saved SQL queries (Trino)

Load `main_orchestration` first (session, token, memory, side-cars). Environment and
token source follow `dlp-preprod`: prod default `https://api.datalens.tech` with the
`get_iam_token` tool; explicit preprod → `https://api.preprod.datalens.tech` with
`yc --profile sandbox-preprod iam create-token`.

RPC headers (always): `Authorization: Bearer <IAM>`, `x-dl-api-version: 3`,
`x-dl-org-id: <org id>` (preprod: `yc.organization-manager.sandbox`).

## API methods (POST, base above)

| Method           | Args                                                              | Notes |
| ---------------- | ----------------------------------------------------------------- | ----- |
| `/rpc/createSqlQuery` | `{workbookId, name, connectionId, query, description?, params?}` | required: `workbookId`, `name`, `connectionId`, `query`. Returns `entry.entryId` |
| `/rpc/getSqlQuery`    | `{sqlQueryId}`                                                    | shows current `data.connectionId`, revId |
| `/rpc/updateSqlQuery`| `{sqlQueryId, query, connectionId?, description?}`                | `query` is REQUIRED even when only changing `connectionId` |
| `/rpc/deleteSqlQuery`| `{sqlQueryId}`                                                    | |
| `/rpc/runSqlQuery`   | `{sqlQueryId, params?}`                                           | check `executed_query.status == "success"`; errors in `results[].error.details.db_message` |

Full schemas: `GET /json/` → `components.schemas.CreateSqlQueryArgs` etc.

## MANDATORY — determine workbook and connection before creating

`createSqlQuery` needs a concrete `workbookId` AND a `connectionId` that can reach the
target data. If **either is not determined** (user did not specify it, the name does not
resolve, or several candidates exist) — **ask the user which workbook / which connection
to use. Never guess or silently pick one.**

- **Workbook**: resolve via `/rpc/getWorkbooksList` (`filterString`, `collectionId`) and
  `/rpc/getCollectionContent` (`{collectionId}`) to walk collections. Note: a path like
  `/Philipp test` is usually a *collection*; the SQL query must live in a *workbook*
  (`createSqlQuery` has no collection form). If the collection contains several workbooks
  or none — ask.
- **Connection**: saved queries execute **through a connection** (supported types:
  PostgreSQL, ClickHouse, MySQL, Greenplum, **Trino**). To query a lakehouse/Iceberg
  catalog the connection must be Trino pointing at a Trino cluster with that catalog
  attached. Look for existing ones via `/rpc/getEntries`
  `{"scope":"connection","type":"trino","includeData":true}` (data shows `host`,
  `auth_type`, `username`) or `/rpc/getWorkbookEntries {"workbookId"}`. If no suitable
  connection exists or the choice is ambiguous — ask before creating one.

## Trino connection to a lakehouse catalog (verified recipe, 2026-09-16)

1. Find a cluster: `/rpc/listTrinoClusters` → pick `status=RUNNING` + `health=ALIVE` whose
   `config.catalogsConfig[].catalogId` == the REST catalog id; `/rpc/getTrinoCluster
   {"id"}` → `coordinatorUrl` = `<dlpClusterId>.proxy.lakehouse.<env>.yandexcloud.net`.
   The catalog **name inside SQL** is the catalog title (e.g. `dlback-test-catalog-10`);
   objects are addressed as `"<catalog>".<schema>.<table>` (3-level).
2. `/rpc/createConnection`:

```json
{
  "type": "trino",
  "name": "<unique name>",
  "dir_path": "/<collection>/<workbook>",
  "workbook_id": "<workbookId>",
  "host": "<coordinatorUrl>",
  "port": 443,
  "username": "iam",
  "auth_type": "password",
  "password": "<fresh IAM token>",
  "ssl_enable": "on",
  "raw_sql_level": "readwrite",
  "listing_sources": "on"
}
```

   - `ssl_enable` must be the **string** `"on"` (boolean → 400 "Not a valid boolean").
   - `auth_type: "none"` does NOT work for execution: the lakehouse proxy requires a
     Bearer token and the run fails with `502 bad gateway`.
   - **Caveat**: `password` is a static IAM token and expires in ≤12 h — for a
     long-lived query refresh it (`/rpc/updateConnection`) or use a UI connection.

3. Bind the query: `createSqlQuery` with the new `connectionId`; to rebind an existing
   query use `updateSqlQuery` **passing `query` again**.

## SQL dialect

Trino. `information_schema` works per catalog, DDL incl. `CREATE OR REPLACE TABLE ... AS
SELECT` works (Iceberg). Example — persist the list of all tables of a schema into a
table:

```sql
CREATE OR REPLACE TABLE "dlback-test-catalog-10".marts.table_list AS
SELECT table_catalog, table_schema, table_name, table_type
FROM "dlback-test-catalog-10".information_schema.tables
WHERE table_schema = 'marts'
```

## Verify

After creating, run `/rpc/runSqlQuery {"sqlQueryId": "<entryId>"}` and confirm
`executed_query.status == "success"`. Log the entryId / connectionId in
`memory/infrastructure.md` and the session side-cars `log.md`.
