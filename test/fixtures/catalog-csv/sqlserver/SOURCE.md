# sqlserver/probe.csv

- **Platform:** Microsoft SQL Server 2022 (RTM-CU27-GDR) (KB5129300) - 16.0.4315.2 (X64) Oct 21 2026 13:09:05 Copyright (C) 2022 Microsoft Corporation Developer Edition (64-bit) on Linux (Ubuntu 22.04.5 LTS) <X64> (Docker `mcr.microsoft.com/mssql/server:2022-latest`, linux/amd64).
- **Exported:** 2026-11-11, by `run_sqlserver.sh`: the query `../queries/sqlserver.sql` run through Microsoft SqlToolsService 6.0.20261002.1 (the service the VS Code SQL Server extension, mssql 1.47.0, runs) and saved with its **Save as CSV** request (`query/saveCsv`) with the parameters the extension sends at its default settings (headers, comma, double quote, UTF-8, the platform's line break). Unchanged. The Save as CSV click in VS Code itself was not driven: the request it sends was.
- **probe.rows.json:** the same query's rows as JSON (`FOR JSON PATH, INCLUDE_NULL_VALUES` through sqlcmd), to check the CSV cell by cell.
- **probe-smo-script.sql:** the same database scripted by SqlToolsService's SMO scripting (`scripting/script`: what **Script as Create** and SSMS's Generate Scripts use), schema only, with keys, indexes, defaults and extended properties; UTF-16 with a byte order mark, as written. Unchanged. For the DDL route.
- **Schema:** `probe-schema.sql`, a synthetic probe schema made up for the test (no real names or data); its truth is `truth.json`.
