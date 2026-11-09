# Chinook for SQLite (SQLite)

Import type: **SQL DDL, SQLite**. Pick `DataSources/Chinook_Sqlite.sql` in **Import SQL DDL…**; the dialect is detected.

## What it is

The Chinook sample database (a digital media store) as its SQLite script: `DROP TABLE IF EXISTS`, eleven
`CREATE TABLE`s with square-bracket names (`[AlbumId]`), every foreign key declared inside its table (SQLite has no
`ALTER TABLE … ADD CONSTRAINT`), `CREATE INDEX` on each foreign key, then the data as multi-row `INSERT`s.

Before the SQLite dialect it was detected as SQL Server (the brackets) and read as such.

## Where it came from

- Project: https://github.com/lerocha/chinook-database
- Pin: commit `4a944a942426e1f3263fe539155fb7ef92b04b4a` (tag `v1.4.5`), as pinned by the import corpus (`scripts/corpus/manifest.json` on `wip/b-corpus`, 2026-11-09).
- Files (`ChinookDatabase/DataSources/` upstream, `DataSources/` here):
  - https://raw.githubusercontent.com/lerocha/chinook-database/4a944a942426e1f3263fe539155fb7ef92b04b4a/ChinookDatabase/DataSources/Chinook_Sqlite.sql
- SHA-256:
  - `DataSources/Chinook_Sqlite.sql` (611,447 bytes): `fdcb271b3e9c840216b09168752bddca973ed3917b40e49b603b15831114aea1`
- Downloaded 2026-11-09; each file's SHA-256 checked against the pinned manifest.

## Licence

MIT (`LICENSE.md` at the repository root, "Copyright (c) 2008-2024 Luis Rocha"; the script's header links
to it). Copied to `UPSTREAM-LICENSE.txt`; the script is unchanged.

## What was copied

- `DataSources/Chinook_Sqlite.sql`, byte for byte.
- Nothing else from the repository.

## Expected counts

Counted by sqlglot 27.29 (sqlite) over the upstream file, never through ERD Studio (11 of 11 CREATE TABLE statements), types re-read as written (sqlglot reads NVARCHAR as TEXT). Square-bracket names; every foreign key is declared inside its table, as SQLite requires; the 15,000 INSERT rows are data.

- Tables: **11**
- Columns: **64**
- Primary keys: **11**
- Foreign keys / relationships: **11**
- Descriptions: **0**

| Table | Columns | Primary key | Foreign keys (column → target) |
|---|---|---|---|
| Album | 3 | AlbumId | ArtistId → Artist |
| Artist | 2 | ArtistId | – |
| Customer | 13 | CustomerId | SupportRepId → Employee |
| Employee | 15 | EmployeeId | ReportsTo → Employee |
| Genre | 2 | GenreId | – |
| Invoice | 9 | InvoiceId | CustomerId → Customer |
| InvoiceLine | 5 | InvoiceLineId | InvoiceId → Invoice; TrackId → Track |
| MediaType | 2 | MediaTypeId | – |
| Playlist | 2 | PlaylistId | – |
| PlaylistTrack | 2 | PlaylistId, TrackId | PlaylistId → Playlist; TrackId → Track |
| Track | 9 | TrackId | AlbumId → Album; GenreId → Genre; MediaTypeId → MediaType |
