#!/usr/bin/env bash
# One command, once Docker runs: SQL Server in a throwaway container, the probe schema, the catalog query
# (../queries/sqlserver.sql) saved as CSV by the VS Code mssql extension's own writer, a lossless copy of the
# same rows for a cross-check, an SMO script of the same schema (the DDL route), then the tests.
#
#   test/fixtures/catalog-csv/sqlserver/run_sqlserver.sh            (from the repo root; npm ci first)
#
# Writes, next to this script: probe.csv, probe.rows.json, probe-smo-script.sql, SOURCE.md.
# Removes its container, and any image it pulled (an image that was already there is kept).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
QUERY="$REPO/test/fixtures/catalog-csv/queries/sqlserver.sql"
PORT="${PORT:-14333}"
STS_VERSION="6.0.20261104.1" # the SqlToolsService the mssql extension 1.48 pins (extensions/mssql/src/configurations/config.ts)
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/erd-studio-sts/$STS_VERSION"
WORK="$(mktemp -d)"
NAME="erd-catalog-mssql-$$"

docker info >/dev/null 2>&1 || { echo "Docker is not running: start Docker Desktop and run this again." >&2; exit 1; }
command -v node >/dev/null || { echo "node is needed (the repo's own)." >&2; exit 1; }

# --- SqlToolsService (the VS Code mssql extension's service), cached -------------------------------------------
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) STS_FILE=osx-arm64-net10.0.tar.gz ;; Darwin-x86_64) STS_FILE=osx-x64-net10.0.tar.gz ;;
  Linux-aarch64) STS_FILE=linux-arm64-net10.0.tar.gz ;; Linux-x86_64) STS_FILE=linux-x64-net10.0.tar.gz ;;
  *) echo "unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
STS="$CACHE/MicrosoftSqlToolsServiceLayer"
if [ ! -x "$STS" ]; then
  mkdir -p "$CACHE"
  curl -fsSL -o "$CACHE/sts.tar.gz" "https://github.com/Microsoft/sqltoolsservice/releases/download/$STS_VERSION/microsoft.sqltools.servicelayer-$STS_FILE"
  tar -xzf "$CACHE/sts.tar.gz" -C "$CACHE"
fi

# --- SQL Server ---------------------------------------------------------------------------------------------------
PASSWORD="Erd-$(openssl rand -hex 12)!a1"
PULLED=""
IMAGE=""
for candidate in mcr.microsoft.com/mssql/server:2022-latest mcr.microsoft.com/mssql/server:2025-latest mcr.microsoft.com/azure-sql-edge:latest; do
  had=0; docker image inspect "$candidate" >/dev/null 2>&1 && had=1
  platform=(--platform linux/amd64); [[ "$candidate" == *azure-sql-edge* ]] && platform=()
  if [ "$had" = 1 ] || docker pull "${platform[@]}" "$candidate" >/dev/null; then
    [ "$had" = 0 ] && PULLED="$candidate"
    if docker run -d --rm "${platform[@]}" --name "$NAME" -p "127.0.0.1:$PORT:1433" \
         -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD="$PASSWORD" -e MSSQL_PID=Developer "$candidate" >/dev/null; then
      IMAGE="$candidate"; break
    fi
    [ -n "$PULLED" ] && docker rmi "$PULLED" >/dev/null 2>&1 || true; PULLED=""
  fi
done
[ -n "$IMAGE" ] || { echo "no SQL Server image would run" >&2; exit 1; }
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  [ -n "$PULLED" ] && docker rmi "$PULLED" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# sqlcmd: the container's own when it has one (server images), else the host's go-sqlcmd (azure-sql-edge has none).
sql() {
  if docker exec "$NAME" test -x /opt/mssql-tools18/bin/sqlcmd 2>/dev/null; then
    docker exec -i -e SQLCMDPASSWORD="$PASSWORD" "$NAME" /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa "$@"
  elif docker exec "$NAME" test -x /opt/mssql-tools/bin/sqlcmd 2>/dev/null; then
    docker exec -i -e SQLCMDPASSWORD="$PASSWORD" "$NAME" /opt/mssql-tools/bin/sqlcmd -S localhost -U sa "$@"
  else
    SQLCMDPASSWORD="$PASSWORD" sqlcmd -C -S "localhost,$PORT" -U sa "$@"
  fi
}
# A script file: copied into the container for its sqlcmd, else read from the host.
sql_file() {
  local file="$1"; shift
  if docker exec "$NAME" sh -c 'test -x /opt/mssql-tools18/bin/sqlcmd || test -x /opt/mssql-tools/bin/sqlcmd' 2>/dev/null; then
    docker cp "$file" "$NAME:/tmp/$(basename "$file")" && sql "$@" -i "/tmp/$(basename "$file")"
  else
    sql "$@" -i "$file"
  fi
}
for _ in $(seq 1 240); do sql -Q "SELECT 1" >/dev/null 2>&1 && break; sleep 1; done
sql -b -Q "CREATE DATABASE erd_probe" >/dev/null
sql_file "$HERE/probe-schema.sql" -b -d erd_probe >/dev/null
VERSION="$(sql -h -1 -W -Q "SET NOCOUNT ON; SELECT REPLACE(REPLACE(@@VERSION, CHAR(10), ' '), CHAR(9), ' ')" | head -1)"
echo "SQL Server: $VERSION"

# --- Export 1: the extension's Save as CSV (query/saveCsv), and its SMO script of the schema --------------------
PROBE_PW="$PASSWORD" node "$HERE/sts-save-csv.mjs" --service "$STS" --server "localhost,$PORT" --database erd_probe \
  --user sa --password-env PROBE_PW --query-file "$QUERY" --out "$HERE/probe.csv" --script-out "$WORK/smo.sql"
if [ -s "$WORK/smo.sql" ]; then cp "$WORK/smo.sql" "$HERE/probe-smo-script.sql"; else echo "(no SMO script: see the [sts] log above)"; fi

# --- Export 2: the same rows as JSON, lossless, for the cross-check -----------------------------------------------
{
  echo "SET NOCOUNT ON;"
  echo "DECLARE @j nvarchar(max) = (SELECT * FROM ("
  grep -v '^ORDER BY' "$QUERY"
  echo ") q FOR JSON PATH, INCLUDE_NULL_VALUES);"
  echo "SELECT @j;"
} > "$WORK/rows.sql"
sql_file "$WORK/rows.sql" -b -d erd_probe -y 0 -h -1 | grep '^\[' > "$HERE/probe.rows.json"

cat > "$HERE/SOURCE.md" <<EOF
# sqlserver/probe.csv

- **Platform:** $VERSION (Docker \`$IMAGE\`).
- **Exported:** $(date -u +%Y-%m-%d), by \`run_sqlserver.sh\`: the query \`../queries/sqlserver.sql\` run and saved through Microsoft SqlToolsService $STS_VERSION (the service the VS Code mssql extension runs) with its **Save as CSV** request and the extension's default CSV settings. Unchanged.
- **probe.rows.json:** the same query's rows as JSON (\`FOR JSON PATH, INCLUDE_NULL_VALUES\` through sqlcmd), to check the CSV cell by cell.
- **probe-smo-script.sql:** the same schema scripted by SqlToolsService's SMO scripting (what **Script as Create** and Generate Scripts use), for the DDL route.
- **Schema:** \`probe-schema.sql\`, a synthetic probe schema; its truth is \`truth.json\`.
EOF

cd "$REPO" && npx vitest run test/unit/catalogCsvImport.sqlserver.test.ts
