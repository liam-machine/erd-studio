#!/usr/bin/env bash
# One command, once Docker runs: SQL Server in a container, the probe schema, the catalog query
# (../queries/sqlserver.sql) saved as CSV by the VS Code mssql extension's own writer, a lossless copy of the
# same rows for a cross-check, an SMO script of the same schema (the DDL route), then the tests.
#
#   test/fixtures/catalog-csv/sqlserver/run_sqlserver.sh            (from the repo root; npm ci first)
#
# Writes, next to this script: probe.csv, probe.rows.json, probe-smo-script.sql, SOURCE.md (each replaced).
# Safe to run again: the database is dropped and made afresh every run.
#
# Its own container (erd-catalog-mssql) is removed at the end, and the image too if this run pulled it.
# To iterate without pulling, keep a container running and point at it (nothing of it is removed):
#   MSSQL_CONTAINER=<name> MSSQL_SA_PASSWORD=<its sa password> PORT=<its host port> run_sqlserver.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
QUERY="$REPO/test/fixtures/catalog-csv/queries/sqlserver.sql"
PORT="${PORT:-14333}"
IMAGE="mcr.microsoft.com/mssql/server:2022-latest" # amd64 only: runs under emulation on Apple silicon
STS_VERSION="6.0.20261002.1" # the SqlToolsService the mssql extension 1.47.0 (Marketplace, 2026-11) ships and pins
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/erd-studio-sts/$STS_VERSION"
WORK="$(mktemp -d)"
step() { printf '\n== %s\n' "$*" >&2; }
die() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

docker info >/dev/null 2>&1 || die "Docker is not running: start Docker Desktop and run this again."
command -v node >/dev/null || die "node is needed (the repo's own)."

# --- SqlToolsService (the VS Code mssql extension's service), cached -------------------------------------------
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) STS_FILE=osx-arm64-net10.0.tar.gz ;; Darwin-x86_64) STS_FILE=osx-x64-net10.0.tar.gz ;;
  Linux-aarch64) STS_FILE=linux-arm64-net10.0.tar.gz ;; Linux-x86_64) STS_FILE=linux-x64-net10.0.tar.gz ;;
  *) die "unsupported platform $(uname -s)-$(uname -m)" ;;
esac
STS="$CACHE/MicrosoftSqlToolsServiceLayer"
if [ ! -x "$STS" ]; then
  step "Downloading SqlToolsService $STS_VERSION ($STS_FILE)"
  mkdir -p "$CACHE"
  curl -fsSL -o "$CACHE/sts.tar.gz" "https://github.com/Microsoft/sqltoolsservice/releases/download/$STS_VERSION/microsoft.sqltools.servicelayer-$STS_FILE"
  tar -xzf "$CACHE/sts.tar.gz" -C "$CACHE"
fi

# --- SQL Server ---------------------------------------------------------------------------------------------------
PULLED=""
if [ -n "${MSSQL_CONTAINER:-}" ]; then
  NAME="$MSSQL_CONTAINER"
  [ -n "${MSSQL_SA_PASSWORD:-}" ] || die "MSSQL_CONTAINER needs MSSQL_SA_PASSWORD (its sa password)."
  PASSWORD="$MSSQL_SA_PASSWORD"
  step "Using the running container $NAME (localhost:$PORT)"
  cleanup() { rm -rf "$WORK"; }
  trap cleanup EXIT
else
  NAME="erd-catalog-mssql"
  PASSWORD="Erd-$(openssl rand -hex 12)!a1"
  docker rm -f "$NAME" >/dev/null 2>&1 || true # a container a stopped run left behind
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    step "Pulling $IMAGE (about 1.5 GB)"
    docker pull --platform linux/amd64 "$IMAGE" >/dev/null
    PULLED="$IMAGE"
  fi
  cleanup() {
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    if [ -n "$PULLED" ]; then docker rmi "$PULLED" >/dev/null 2>&1 || true; fi
    rm -rf "$WORK"
  }
  trap cleanup EXIT
  step "Starting SQL Server ($IMAGE) on 127.0.0.1:$PORT"
  docker run -d --platform linux/amd64 --name "$NAME" -p "127.0.0.1:$PORT:1433" \
    -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD="$PASSWORD" -e MSSQL_PID=Developer "$IMAGE" >/dev/null
fi

# sqlcmd inside the container (the 2022 image has mssql-tools18). Output goes to a log; a failure prints it.
sql() { docker exec -i -e SQLCMDPASSWORD="$PASSWORD" "$NAME" /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa "$@"; }
run_sql() { # run_sql <what> <sqlcmd args…>: SQL Server's own error on failure
  local what="$1"; shift
  if ! sql "$@" >"$WORK/sqlcmd.log" 2>&1; then cat "$WORK/sqlcmd.log" >&2; die "$what"; fi
}
copy_in() { docker cp "$1" "$NAME:/tmp/$(basename "$1")" >/dev/null; }

step "Waiting for SQL Server"
up=0
for _ in $(seq 1 240); do if sql -Q "SELECT 1" >/dev/null 2>&1; then up=1; break; fi; sleep 1; done
[ "$up" = 1 ] || { docker logs --tail 30 "$NAME" >&2 || true; die "SQL Server did not accept a login in 240 s"; }

step "Creating erd_probe and loading probe-schema.sql"
run_sql "dropping and creating erd_probe" -b -Q "IF DB_ID('erd_probe') IS NOT NULL BEGIN ALTER DATABASE erd_probe SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE erd_probe; END; CREATE DATABASE erd_probe"
copy_in "$HERE/probe-schema.sql"
run_sql "loading probe-schema.sql" -b -d erd_probe -i /tmp/probe-schema.sql
VERSION="$(sql -h -1 -W -Q "SET NOCOUNT ON; SELECT REPLACE(REPLACE(REPLACE(@@VERSION, CHAR(13), ''), CHAR(10), ' '), CHAR(9), ' ')" | head -1 | tr -s ' ')"
echo "SQL Server: $VERSION" >&2

# --- Export 1: the extension's Save as CSV (query/saveCsv), and SMO's script of the schema ------------------------
step "Running the catalog query through SqlToolsService and saving it with query/saveCsv"
rm -f "$HERE/probe.csv" "$WORK/smo.sql"
PROBE_PW="$PASSWORD" node "$HERE/sts-save-csv.mjs" --service "$STS" --server "localhost,$PORT" --database erd_probe \
  --user sa --password-env PROBE_PW --query-file "$QUERY" --out "$HERE/probe.csv" --script-out "$WORK/smo.sql" \
  || die "SqlToolsService (see the [sts] lines above)"
[ -s "$HERE/probe.csv" ] || die "query/saveCsv answered but wrote no probe.csv"
[ -s "$WORK/smo.sql" ] || die "scripting/script answered but wrote no script"
cp "$WORK/smo.sql" "$HERE/probe-smo-script.sql"

# --- Export 2: the same rows as JSON, lossless, for the cross-check -----------------------------------------------
step "Reading the same rows as JSON (FOR JSON PATH) for the cell-by-cell check"
{
  echo "SET NOCOUNT ON;"
  echo "DECLARE @j nvarchar(max) = (SELECT * FROM ("
  grep -v '^ORDER BY' "$QUERY"
  echo ") q FOR JSON PATH, INCLUDE_NULL_VALUES);"
  echo "SELECT @j;"
} > "$WORK/rows.sql"
copy_in "$WORK/rows.sql"
run_sql "the FOR JSON copy of the catalog query" -b -d erd_probe -y 0 -i /tmp/rows.sql
grep '^\[' "$WORK/sqlcmd.log" > "$HERE/probe.rows.json" || die "no JSON array in sqlcmd's output"
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); if(!r.length) process.exit(1); console.error(`rows: ${r.length}`)' "$HERE/probe.rows.json" \
  || die "probe.rows.json is not a JSON array of rows"

cat > "$HERE/SOURCE.md" <<EOF
# sqlserver/probe.csv

- **Platform:** $VERSION (Docker \`$IMAGE\`, linux/amd64).
- **Exported:** $(date -u +%Y-%m-%d), by \`run_sqlserver.sh\`: the query \`../queries/sqlserver.sql\` run through Microsoft SqlToolsService $STS_VERSION (the service the VS Code SQL Server extension, mssql 1.47.0, runs) and saved with its **Save as CSV** request (\`query/saveCsv\`) with the parameters the extension sends at its default settings (headers, comma, double quote, UTF-8, the platform's line break). Unchanged. The Save as CSV click in VS Code itself was not driven: the request it sends was.
- **probe.rows.json:** the same query's rows as JSON (\`FOR JSON PATH, INCLUDE_NULL_VALUES\` through sqlcmd), to check the CSV cell by cell.
- **probe-smo-script.sql:** the same database scripted by SqlToolsService's SMO scripting (\`scripting/script\`: what **Script as Create** and SSMS's Generate Scripts use), schema only, with keys, indexes, defaults and extended properties; UTF-16 with a byte order mark, as written. Unchanged. For the DDL route.
- **Schema:** \`probe-schema.sql\`, a synthetic probe schema made up for the test (no real names or data); its truth is \`truth.json\`.
EOF

step "Importing it: test/unit/catalogCsvImport.sqlserver.test.ts"
cd "$REPO" && npx vitest run test/unit/catalogCsvImport.sqlserver.test.ts
