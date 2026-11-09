#!/usr/bin/env python3
"""Database truth for the real-world import samples.

Loads each SQL sample in test/fixtures/real-world-imports/ into the real
engine (or the closest local one), reads the schema back from the engine's
catalog and writes it, normalised, to test/real-world-truth/engine/<sample>.json.
test/unit/realWorldEngineTruth.test.ts compares that read-back with
expected.json; docs/dev/real-world-truth.md says how to rerun it.

    python3 -I test/real-world-truth/readback.py all
    python3 -I test/real-world-truth/readback.py postgres-pagila mysql-sakila

Standard library only. The engines it starts are scratch ones (a temporary
data directory, a free TCP port on 127.0.0.1, stopped and deleted afterwards).
The sample files are only ever sent to the engine as SQL text; nothing in them
is executed by Python or the shell.

Engines (each overridable with an environment variable):
  PostgreSQL 18  RWT_PG_BIN     (default /opt/homebrew/opt/postgresql@18/bin; Pagila also needs pgvector)
  MySQL 8.0      RWT_MYSQL_BIN  (default /opt/homebrew/opt/mysql@8.0/bin; RWT_MYSQL_LIBS for a stale abseil)
  RWT_DOCKER=1   runs PostgreSQL and MySQL in Docker instead (RWT_PG_IMAGE postgres:18, RWT_PG_VECTOR_IMAGE
                 pgvector/pgvector:pg18 for Pagila, RWT_MYSQL_IMAGE mysql:8.0)
  SQL Server     Docker only    (mcr.microsoft.com/mssql/server:2022-latest; see the doc)
  Snowflake      RWT_SNOWFLAKE_PYTHON: a Python with fakesnow installed (an emulator on DuckDB)
  Databricks     RWT_SPARK_PYTHON: a Python with pyspark installed (Spark's own SQL parser)
"""
from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SAMPLES = REPO / 'test' / 'fixtures' / 'real-world-imports'
OUT = Path(os.environ['RWT_OUT']) if os.environ.get('RWT_OUT') else HERE / 'engine'


def rel(p: Path) -> str:
    return p.resolve().relative_to(SAMPLES.resolve()).as_posix()


def free_port() -> int:
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def short_tmp(prefix: str) -> str:
    """A short temporary directory (Unix socket paths are limited to ~100 bytes)."""
    for base in (os.environ.get('RWT_TMP'), '/tmp/claude-501', '/tmp', None):
        if base is None or os.path.isdir(base):
            try:
                return tempfile.mkdtemp(prefix=prefix, dir=base)
            except OSError:
                continue
    return tempfile.mkdtemp(prefix=prefix)


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


# An engine message can quote a long statement: keep the message short.
def short(msg: str, limit: int = 200) -> str:
    msg = ' '.join(msg.split())
    return msg if len(msg) <= limit else msg[: limit - 1] + '…'


# ---------------------------------------------------------------------------
# PostgreSQL
# ---------------------------------------------------------------------------

PG_CATALOG_SQL = r"""
with rels as (
  select c.oid, n.nspname as schema, c.relname as name, c.relkind, c.relispartition,
         obj_description(c.oid, 'pg_class') as comment
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p')
    and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%%'
    and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
)
select json_build_object(
  'version', version(),
  'tables', coalesce((select json_agg(json_build_object(
      'schema', r.schema, 'name', r.name, 'comment', r.comment,
      'partitioned', r.relkind = 'p',
      'partitionOf', (select pn.nspname || '.' || pc.relname from pg_inherits i join pg_class pc on pc.oid = i.inhparent
                      join pg_namespace pn on pn.oid = pc.relnamespace where i.inhrelid = r.oid and r.relispartition),
      'pk', (select json_agg(a.attname order by k.ord) from pg_constraint con
               cross join unnest(con.conkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
             where con.conrelid = r.oid and con.contype = 'p'),
      'columns', (select json_agg(json_build_object(
            'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'notNull', a.attnotnull,
            'generated', case a.attgenerated when 's' then 'stored' when 'v' then 'virtual' else null end,
            'identity', case a.attidentity when 'a' then 'always' when 'd' then 'by default' else null end,
            'default', pg_get_expr(ad.adbin, ad.adrelid),
            'comment', col_description(r.oid, a.attnum)) order by a.attnum)
          from pg_attribute a left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
          where a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped)
    ) order by r.schema, r.name) from rels r), '[]'::json),
  'uniqueKeys', coalesce((select json_agg(u order by u->>'schema', u->>'table', u->>'name') from (
      select json_build_object('schema', r.schema, 'table', r.name, 'name', ic.relname,
        'kind', case when con.oid is not null then 'constraint' else 'index' end,
        'partial', x.indpred is not null,
        'columns', (select json_agg(case when k.attnum = 0 then pg_get_indexdef(x.indexrelid, k.ord::int, true) else a.attname end order by k.ord)
                    from unnest(x.indkey::int2[]) with ordinality k(attnum, ord)
                    left join pg_attribute a on a.attrelid = r.oid and a.attnum = k.attnum),
        'definition', pg_get_indexdef(x.indexrelid)) as u
      from rels r join pg_index x on x.indrelid = r.oid join pg_class ic on ic.oid = x.indexrelid
      left join pg_constraint con on con.conindid = x.indexrelid and con.contype = 'u'
      where x.indisunique and not x.indisprimary) s), '[]'::json),
  'foreignKeys', coalesce((select json_agg(json_build_object(
      'schema', r.schema, 'table', r.name, 'name', con.conname,
      'columns', (select json_agg(a.attname order by k.ord) from unnest(con.conkey) with ordinality k(attnum, ord)
                  join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum),
      'refSchema', fn.nspname, 'refTable', fc.relname,
      'refColumns', (select json_agg(a.attname order by k.ord) from unnest(con.confkey) with ordinality k(attnum, ord)
                     join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum),
      'inherited', con.conparentid <> 0
    ) order by r.schema, r.name, con.conname)
    from rels r join pg_constraint con on con.conrelid = r.oid and con.contype = 'f'
    join pg_class fc on fc.oid = con.confrelid join pg_namespace fn on fn.oid = fc.relnamespace), '[]'::json)
)::text;
"""

PSQL_ERR = re.compile(r'^psql:(?P<file>.*?):(?P<line>\d+): (?P<level>ERROR|FATAL):\s*(?P<msg>.*)$')


def docker_mode() -> bool:
    return os.environ.get('RWT_DOCKER', '') not in ('', '0')


def wait_for(cmd: list[str], what: str, tries: int = 240) -> None:
    for _ in range(tries):
        if run(cmd).returncode == 0:
            return
        time.sleep(1)
    raise RuntimeError(f'{what} did not start')


def docker_start(prefix: str, image: str, env: list[str]) -> str:
    """A throwaway container with the samples mounted read-only at /samples."""
    if run(['docker', 'info']).returncode != 0:
        raise RuntimeError('RWT_DOCKER is set but Docker is not running')
    name = f'{prefix}-{os.getpid()}'
    args = ['docker', 'run', '-d', '--rm', '--name', name, '-v', f'{SAMPLES}:/samples:ro']
    for e in env:
        args += ['-e', e]
    r = run([*args, image])
    if r.returncode != 0:
        raise RuntimeError(f'docker run {image} failed: {short(r.stderr)}')
    return name


def in_container(p: Path) -> str:
    return f'/samples/{rel(p)}'


def from_container(path: str) -> str:
    return path[len('/samples/'):] if path.startswith('/samples/') else rel(Path(path))


class Postgres:
    """PostgreSQL 18: Homebrew's binaries on a scratch cluster, or (RWT_DOCKER=1) a container."""

    def __init__(self, image: str | None = None) -> None:
        self.bin = Path(os.environ.get('RWT_PG_BIN', '/opt/homebrew/opt/postgresql@18/bin'))
        self.image = (image or os.environ.get('RWT_PG_IMAGE', 'postgres:18')) if docker_mode() else None
        self.container: str | None = None
        self.dir = short_tmp('rwt-pg-')
        self.port = free_port()

    def __enter__(self) -> 'Postgres':
        if self.image:
            self.container = docker_start('rwt-pg', self.image, ['POSTGRES_HOST_AUTH_METHOD=trust'])
            # The image's first start runs a socket-only server, then the real one: wait for TCP.
            wait_for(['docker', 'exec', self.container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], 'postgres')
            time.sleep(1)
            wait_for(['docker', 'exec', self.container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-c', 'select 1'], 'postgres')
            return self
        data = os.path.join(self.dir, 'data')
        r = run([str(self.bin / 'initdb'), '-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C'])
        if r.returncode != 0:
            raise RuntimeError(f'initdb failed: {short(r.stderr)}')
        opts = f"-p {self.port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off"
        r = run([str(self.bin / 'pg_ctl'), '-D', data, '-o', opts, '-l', os.path.join(self.dir, 'log'), '-w', 'start'])
        if r.returncode != 0:
            raise RuntimeError(f'postgres did not start: {short(r.stdout + r.stderr)}')
        return self

    def __exit__(self, *exc) -> None:
        if self.container:
            run(['docker', 'rm', '-f', self.container])
        else:
            run([str(self.bin / 'pg_ctl'), '-D', os.path.join(self.dir, 'data'), '-m', 'fast', '-w', 'stop'])
        shutil.rmtree(self.dir, ignore_errors=True)

    @property
    def where(self) -> str:
        return f' (Docker {self.image})' if self.image else ''

    def psql(self, db: str, *args: str) -> subprocess.CompletedProcess:
        if self.container:
            return run(['docker', 'exec', self.container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-X', '-q', '-d', db, *args])
        return run([str(self.bin / 'psql'), '-h', '127.0.0.1', '-p', str(self.port), '-U', 'postgres', '-X', '-q', '-d', db, *args])

    def load(self, db: str, files: list[Path], setup: str | None = None) -> list[dict]:
        r = self.psql('postgres', '-c', f'create database "{db}"')
        if r.returncode != 0:
            raise RuntimeError(short(r.stderr))
        if setup:
            r = self.psql(db, '-v', 'ON_ERROR_STOP=1', '-c', setup)
            if r.returncode != 0:
                raise RuntimeError(short(r.stderr))
        errors: list[dict] = []
        for f in files:
            r = self.psql(db, '-v', 'ON_ERROR_STOP=0', '-f', in_container(f) if self.container else str(f))
            for line in r.stderr.splitlines():
                m = PSQL_ERR.match(line)
                if m:
                    errors.append({'file': from_container(m['file']), 'line': int(m['line']), 'error': short(m['msg'])})
        return errors

    def catalog(self, db: str) -> dict:
        r = self.psql(db, '-A', '-t', '-c', PG_CATALOG_SQL.replace('%%', '%'))
        if r.returncode != 0:
            raise RuntimeError(short(r.stderr))
        return json.loads(r.stdout)


def postgres_sample(files: list[Path], setup: str | None = None, hidden: tuple[str, ...] = (), image: str | None = None) -> dict:
    with Postgres(image) as pg:
        errors = pg.load('sample', files, setup)
        cat = pg.catalog('sample')
        where = pg.where
    cat['tables'] = [t for t in cat['tables'] if f"{t['schema']}.{t['name']}" not in hidden]
    return {
        'engine': cat.pop('version').split(' on ')[0] + where,
        'loaded': [rel(f) for f in files],
        **({'setup': setup} if setup else {}),
        **({'hidden': list(hidden)} if hidden else {}),
        'errors': errors,
        **cat,
    }


def pagila() -> dict:
    # The dump creates the vector extension (pgvector): the Homebrew pgvector formula, or in Docker the
    # pgvector project's image (postgres:18 with the extension).
    return postgres_sample([SAMPLES / 'postgres-pagila' / 'pagila-schema.sql'],
                           image=os.environ.get('RWT_PG_VECTOR_IMAGE', 'pgvector/pgvector:pg18'))


def harbor() -> dict:
    folder = SAMPLES / 'migrations-harbor' / 'make' / 'migrations' / 'postgresql'
    files = sorted(folder.glob('*.up.sql'), key=lambda p: p.name)
    # golang-migrate's PostgreSQL driver creates its own table before the first migration
    # (0030 and 0040 alter it); it is the tool's, not the schema's, so it is not read back.
    setup = 'CREATE TABLE IF NOT EXISTS schema_migrations (version bigint NOT NULL PRIMARY KEY, dirty boolean NOT NULL);'
    return postgres_sample(files, setup, hidden=('public.schema_migrations',))


# ---------------------------------------------------------------------------
# MySQL
# ---------------------------------------------------------------------------

MYSQL_CATALOG_SQL = r"""
SELECT JSON_OBJECT(
 'version', CONCAT('MySQL ', VERSION()),
 'tables', (SELECT JSON_ARRAYAGG(JSON_OBJECT(
     'schema', t.TABLE_SCHEMA, 'name', t.TABLE_NAME, 'comment', NULLIF(t.TABLE_COMMENT, ''),
     'pk', (SELECT GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR '\t') FROM information_schema.KEY_COLUMN_USAGE k
            WHERE k.TABLE_SCHEMA = t.TABLE_SCHEMA AND k.TABLE_NAME = t.TABLE_NAME AND k.CONSTRAINT_NAME = 'PRIMARY'),
     'columns', (SELECT JSON_ARRAYAGG(JSON_OBJECT('pos', c.ORDINAL_POSITION, 'name', c.COLUMN_NAME, 'type', c.COLUMN_TYPE,
                   'notNull', c.IS_NULLABLE = 'NO', 'default', c.COLUMN_DEFAULT,
                   'extra', NULLIF(c.EXTRA, ''), 'srid', c.SRS_ID, 'comment', NULLIF(c.COLUMN_COMMENT, '')))
                 FROM information_schema.COLUMNS c WHERE c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME)))
   FROM information_schema.TABLES t WHERE t.TABLE_SCHEMA = @db AND t.TABLE_TYPE = 'BASE TABLE'),
 'uniqueKeys', (SELECT JSON_ARRAYAGG(JSON_OBJECT('schema', s.TABLE_SCHEMA, 'table', s.TABLE_NAME, 'name', s.INDEX_NAME,
     'kind', IF(tc.CONSTRAINT_NAME IS NULL, 'index', 'constraint'), 'partial', false, 'columns', s.cols))
   FROM (SELECT TABLE_SCHEMA, TABLE_NAME, INDEX_NAME,
           GROUP_CONCAT(COALESCE(COLUMN_NAME, EXPRESSION, '(expression)') ORDER BY SEQ_IN_INDEX SEPARATOR '\t') AS cols
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = @db AND NON_UNIQUE = 0 AND INDEX_NAME <> 'PRIMARY'
         GROUP BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME) s
   LEFT JOIN information_schema.TABLE_CONSTRAINTS tc ON tc.TABLE_SCHEMA = s.TABLE_SCHEMA AND tc.TABLE_NAME = s.TABLE_NAME
     AND tc.CONSTRAINT_NAME = s.INDEX_NAME AND tc.CONSTRAINT_TYPE = 'UNIQUE'),
 'foreignKeys', (SELECT JSON_ARRAYAGG(JSON_OBJECT('schema', f.TABLE_SCHEMA, 'table', f.TABLE_NAME, 'name', f.CONSTRAINT_NAME,
     'columns', f.cols, 'refSchema', f.REFERENCED_TABLE_SCHEMA, 'refTable', f.REFERENCED_TABLE_NAME, 'refColumns', f.refcols,
     'onDelete', rc.DELETE_RULE, 'onUpdate', rc.UPDATE_RULE))
   FROM (SELECT TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME,
           GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION SEPARATOR '\t') AS cols,
           GROUP_CONCAT(REFERENCED_COLUMN_NAME ORDER BY ORDINAL_POSITION SEPARATOR '\t') AS refcols
         FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = @db AND REFERENCED_TABLE_NAME IS NOT NULL
         GROUP BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME) f
   JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA = f.TABLE_SCHEMA AND rc.CONSTRAINT_NAME = f.CONSTRAINT_NAME)
);
"""

MYSQL_ERR = re.compile(r'^ERROR (?P<code>\d+) \([0-9A-Z]+\) at line (?P<line>\d+): (?P<msg>.*)$')


class MySQL:
    """MySQL 8.0: Homebrew's mysql@8.0 on a scratch data directory, or (RWT_DOCKER=1) a container."""

    def __init__(self) -> None:
        self.bin = Path(os.environ.get('RWT_MYSQL_BIN', '/opt/homebrew/opt/mysql@8.0/bin'))
        self.image = os.environ.get('RWT_MYSQL_IMAGE', 'mysql:8.0') if docker_mode() else None
        self.container: str | None = None
        self.dir = short_tmp('rwt-my-')
        self.port = free_port()
        self.sock = os.path.join(self.dir, 's')
        self.proc: subprocess.Popen | None = None
        # A Homebrew mysql@8.0 linked against an abseil that brew has since upgraded: point dyld at the
        # older abseil keg (RWT_MYSQL_LIBS=/opt/homebrew/Cellar/abseil/20240722.1/lib).
        self.env = dict(os.environ)
        if os.environ.get('RWT_MYSQL_LIBS'):
            self.env['DYLD_FALLBACK_LIBRARY_PATH'] = os.environ['RWT_MYSQL_LIBS']

    def __enter__(self) -> 'MySQL':
        if self.image:
            self.container = docker_start('rwt-my', self.image, ['MYSQL_ALLOW_EMPTY_PASSWORD=yes'])
            # The image's first start runs a networking-off server, then the real one: wait for TCP.
            wait_for(['docker', 'exec', self.container, 'mysql', '-uroot', '-h127.0.0.1', '-e', 'select 1'], 'mysqld')
            return self
        data = os.path.join(self.dir, 'data')
        r = run([str(self.bin / 'mysqld'), '--no-defaults', '--initialize-insecure', f'--datadir={data}'], env=self.env)
        if r.returncode != 0:
            raise RuntimeError(f'mysqld --initialize failed: {short(r.stderr)}')
        self.proc = subprocess.Popen([
            str(self.bin / 'mysqld'), '--no-defaults', f'--datadir={data}', f'--port={self.port}', '--bind-address=127.0.0.1',
            f'--socket={self.sock}', '--mysqlx=OFF', f'--log-error={os.path.join(self.dir, "err.log")}',
            f'--pid-file={os.path.join(self.dir, "pid")}', '--skip-log-bin',
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=self.env)
        for _ in range(120):
            if run([str(self.bin / 'mysqladmin'), '--no-defaults', '-uroot', '-h127.0.0.1', f'-P{self.port}', 'ping']).returncode == 0:
                return self
            time.sleep(0.5)
        raise RuntimeError('mysqld did not start')

    def __exit__(self, *exc) -> None:
        if self.container:
            run(['docker', 'rm', '-f', self.container])
            shutil.rmtree(self.dir, ignore_errors=True)
            return
        run([str(self.bin / 'mysqladmin'), '--no-defaults', '-uroot', '-h127.0.0.1', f'-P{self.port}', 'shutdown'])
        if self.proc:
            try:
                self.proc.wait(timeout=60)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        shutil.rmtree(self.dir, ignore_errors=True)

    @property
    def where(self) -> str:
        return f' (Docker {self.image})' if self.image else ''

    def mysql(self, *args: str, stdin: str | None = None) -> subprocess.CompletedProcess:
        if self.container:
            return run(['docker', 'exec', '-i', self.container, 'mysql', '-uroot', '-h127.0.0.1',
                        '--default-character-set=utf8mb4', *args], input=stdin)
        return run([str(self.bin / 'mysql'), '--no-defaults', '-uroot', '-h127.0.0.1', f'-P{self.port}',
                    '--default-character-set=utf8mb4', *args], input=stdin)

    def load(self, files: list[Path]) -> list[dict]:
        errors: list[dict] = []
        for f in files:
            # --force: carry on after an error, as a statement-by-statement load would.
            r = self.mysql('--force', '--comments', stdin=f.read_text(encoding='utf-8'))
            for line in r.stderr.splitlines():
                m = MYSQL_ERR.match(line)
                if m:
                    errors.append({'file': rel(f), 'line': int(m['line']), 'error': short(f"{m['code']}: {m['msg']}")})
        return errors

    def catalog(self, db: str) -> dict:
        r = self.mysql('-N', '-B', '--raw', '-e', f"SET @db = '{db}'; SET SESSION group_concat_max_len = 1000000;" + MYSQL_CATALOG_SQL)
        if r.returncode != 0:
            raise RuntimeError(short(r.stderr))
        return json.loads(r.stdout)


def sakila() -> dict:
    f = SAMPLES / 'mysql-sakila' / 'sakila-schema.sql'
    with MySQL() as my:
        errors = my.load([f])
        cat = my.catalog('sakila')
        where = my.where
    # JSON_ARRAYAGG has no order: lists come as GROUP_CONCAT strings (in order), columns by position.
    split = lambda v: v.split('\t') if v else None
    for t in cat['tables'] or []:
        t['pk'] = split(t['pk'])
        t['columns'] = [{k: v for k, v in c.items() if k != 'pos'} for c in sorted(t['columns'], key=lambda c: c['pos'])]
    for u in cat['uniqueKeys'] or []:
        u['columns'] = split(u['columns'])
    for f_ in cat['foreignKeys'] or []:
        f_['columns'], f_['refColumns'] = split(f_['columns']), split(f_['refColumns'])
    return {'engine': cat.pop('version') + where, 'loaded': [rel(f)], 'errors': errors, **cat}


# ---------------------------------------------------------------------------
# Snowflake (fakesnow) and Databricks (Spark), each in its own Python
# ---------------------------------------------------------------------------

def in_python(env_var: str, helper: str, sample: str) -> dict:
    py = os.environ.get(env_var)
    if not py:
        raise RuntimeError(f'set {env_var} to a Python that has the emulator installed (see docs/dev/real-world-truth.md)')
    env = {**os.environ, 'SPARK_LOCAL_IP': os.environ.get('SPARK_LOCAL_IP', '127.0.0.1')}
    r = run([py, '-I', str(HERE / helper), str(SAMPLES), sample], env=env)
    if r.returncode != 0:
        raise RuntimeError(short(r.stderr[-2000:], 1000))
    # The JSON is the last line (an engine may print its own notices first).
    return json.loads([l for l in r.stdout.splitlines() if l.strip()][-1])


def snowflake() -> dict:
    return in_python('RWT_SNOWFLAKE_PYTHON', 'snowflake_readback.py', 'snowflake-grid-reliability')


def databricks() -> dict:
    return in_python('RWT_SPARK_PYTHON', 'spark_readback.py', 'databricks-open-retail-data-model')


# ---------------------------------------------------------------------------
# SQL Server (Docker: there is no native macOS build)
# ---------------------------------------------------------------------------

MSSQL_IMAGE = os.environ.get('RWT_MSSQL_IMAGE', 'mcr.microsoft.com/mssql/server:2025-latest')

MSSQL_CATALOG_SQL = r"""
SET NOCOUNT ON;
DECLARE @j nvarchar(max) = (SELECT
  @@VERSION AS [version],
  (SELECT s.name AS [schema], t.name AS [name],
     CAST((SELECT ep.value FROM sys.extended_properties ep WHERE ep.class = 1 AND ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description') AS nvarchar(max)) AS [comment],
     JSON_QUERY((SELECT '[' + STRING_AGG('"' + STRING_ESCAPE(c.name, 'json') + '"', ',') WITHIN GROUP (ORDER BY ic.key_ordinal) + ']'
        FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE i.object_id = t.object_id AND i.is_primary_key = 1)) AS [pk],
     (SELECT c.name AS [name],
        CASE WHEN c.is_computed = 1 THEN '(computed)'
             WHEN ty.is_user_defined = 1 THEN SCHEMA_NAME(ty.schema_id) + '.' + ty.name
             WHEN ty.name IN ('varchar', 'char', 'varbinary', 'binary') THEN ty.name + '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS varchar(10)) END + ')'
             WHEN ty.name IN ('nvarchar', 'nchar') THEN ty.name + '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length / 2 AS varchar(10)) END + ')'
             WHEN ty.name IN ('decimal', 'numeric') THEN ty.name + '(' + CAST(c.precision AS varchar(5)) + ',' + CAST(c.scale AS varchar(5)) + ')'
             WHEN ty.name IN ('datetime2', 'time', 'datetimeoffset') THEN ty.name + '(' + CAST(c.scale AS varchar(5)) + ')'
             WHEN ty.name = 'xml' AND c.xml_collection_id <> 0 THEN 'xml(' + CASE WHEN c.is_xml_document = 1 THEN 'DOCUMENT ' ELSE 'CONTENT ' END
                  + (SELECT SCHEMA_NAME(x.schema_id) + '.' + x.name FROM sys.xml_schema_collections x WHERE x.xml_collection_id = c.xml_collection_id) + ')'
             ELSE ty.name END AS [type],
        CASE WHEN c.is_nullable = 0 THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS [notNull],
        CASE WHEN c.is_identity = 1 THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS [identity],
        cc.definition AS [computed],
        dc.definition AS [default],
        CAST((SELECT ep.value FROM sys.extended_properties ep WHERE ep.class = 1 AND ep.major_id = t.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description') AS nvarchar(max)) AS [comment]
      FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id
      LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
      LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
      WHERE c.object_id = t.object_id ORDER BY c.column_id FOR JSON PATH, INCLUDE_NULL_VALUES) AS [columns]
   FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE t.is_ms_shipped = 0
   ORDER BY s.name, t.name FOR JSON PATH, INCLUDE_NULL_VALUES) AS [tables],
  (SELECT SCHEMA_NAME(o.schema_id) AS [schema], o.name AS [table], i.name AS [name],
     CASE WHEN i.is_unique_constraint = 1 THEN 'constraint' ELSE 'index' END AS [kind],
     i.has_filter AS [partial],
     JSON_QUERY((SELECT '[' + STRING_AGG('"' + STRING_ESCAPE(c.name, 'json') + '"', ',') WITHIN GROUP (ORDER BY ic.key_ordinal) + ']'
        FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0)) AS [columns],
     o.type_desc AS [on]
   FROM sys.indexes i JOIN sys.objects o ON o.object_id = i.object_id
   WHERE i.is_unique = 1 AND i.is_primary_key = 0 AND o.is_ms_shipped = 0 AND o.type IN ('U', 'V')
   ORDER BY 1, 2, 3 FOR JSON PATH, INCLUDE_NULL_VALUES) AS [uniqueKeys],
  (SELECT SCHEMA_NAME(t.schema_id) AS [schema], t.name AS [table], fk.name AS [name],
     JSON_QUERY((SELECT '[' + STRING_AGG('"' + STRING_ESCAPE(c.name, 'json') + '"', ',') WITHIN GROUP (ORDER BY k.constraint_column_id) + ']'
        FROM sys.foreign_key_columns k JOIN sys.columns c ON c.object_id = k.parent_object_id AND c.column_id = k.parent_column_id
        WHERE k.constraint_object_id = fk.object_id)) AS [columns],
     SCHEMA_NAME(r.schema_id) AS [refSchema], r.name AS [refTable],
     JSON_QUERY((SELECT '[' + STRING_AGG('"' + STRING_ESCAPE(c.name, 'json') + '"', ',') WITHIN GROUP (ORDER BY k.constraint_column_id) + ']'
        FROM sys.foreign_key_columns k JOIN sys.columns c ON c.object_id = k.referenced_object_id AND c.column_id = k.referenced_column_id
        WHERE k.constraint_object_id = fk.object_id)) AS [refColumns]
   FROM sys.foreign_keys fk JOIN sys.tables t ON t.object_id = fk.parent_object_id JOIN sys.tables r ON r.object_id = fk.referenced_object_id
   ORDER BY 1, 2, 3 FOR JSON PATH, INCLUDE_NULL_VALUES) AS [foreignKeys]
 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES);
SELECT @j;
"""

SQLCMD_ERR = re.compile(r'^Msg (?P<code>\d+), Level (?P<level>\d+), State \d+, (?:Server [^,]*, )?(?:Procedure [^,]*, )?Line (?P<line>\d+)')


def sqlserver() -> dict:
    f = SAMPLES / 'sqlserver-adventureworks' / 'instawdb.sql'
    if run(['docker', 'info']).returncode != 0:
        raise RuntimeError('blocked: needs Docker (SQL Server has no native macOS build). See docs/dev/real-world-truth.md.')
    name = f'rwt-mssql-{os.getpid()}'
    password = 'Rwt-' + os.urandom(12).hex() + '!a1'
    r = run(['docker', 'run', '-d', '--rm', '--platform', 'linux/amd64', '--name', name, '-e', 'ACCEPT_EULA=Y',
             '-e', f'MSSQL_SA_PASSWORD={password}', '-e', 'MSSQL_PID=Developer',
             '-v', f'{f.parent}:/sample:ro', MSSQL_IMAGE])
    if r.returncode != 0:
        raise RuntimeError(f'docker run failed: {short(r.stderr)}')
    try:
        sqlcmd = ['docker', 'exec', name, '/opt/mssql-tools18/bin/sqlcmd', '-C', '-S', 'localhost', '-U', 'sa', '-P', password]
        for _ in range(240):
            if run([*sqlcmd, '-Q', 'SELECT 1']).returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('SQL Server did not start')
        # SQLCMD mode, as the script asks. The data files are not part of the sample, so every
        # BULK INSERT fails ("Cannot bulk load"); the schema does not depend on them.
        load = run([*sqlcmd, '-i', '/sample/instawdb.sql', '-v', 'SqlSamplesSourceDataPath=/sample/no-data/'], timeout=3600)
        errors = []
        lines = load.stdout.splitlines()
        for i, line in enumerate(lines):
            m = SQLCMD_ERR.match(line)
            if m and int(m['level']) >= 11:
                msg = lines[i + 1] if i + 1 < len(lines) else ''
                errors.append({'file': rel(f), 'batchLine': int(m['line']), 'error': short(f"{m['code']}: {msg}")})
        out = run([*sqlcmd, '-d', 'AdventureWorks', '-y', '0', '-Q', MSSQL_CATALOG_SQL])
        if out.returncode != 0:
            raise RuntimeError(short(out.stdout + out.stderr))
        cat = json.loads(next(l for l in out.stdout.splitlines() if l.startswith('{')))
    finally:
        run(['docker', 'rm', '-f', name])
    version = cat.pop('version').splitlines()[0].strip()
    for k in ('tables', 'uniqueKeys', 'foreignKeys'):
        cat[k] = cat.get(k) or []
    return {'engine': version + f' (Docker {MSSQL_IMAGE})', 'loaded': [rel(f)],
            'setup': 'sqlcmd -v SqlSamplesSourceDataPath=/sample/no-data/ (the data CSVs are not in the sample)',
            'errors': errors, **cat}


# Read back, but not compared: left out of the files.
DROPPED = {'default', 'extra'}

READERS = {
    'postgres-pagila': pagila,
    'mysql-sakila': sakila,
    'migrations-harbor': harbor,
    'snowflake-grid-reliability': snowflake,
    'databricks-open-retail-data-model': databricks,
    'sqlserver-adventureworks': sqlserver,
}


def main(argv: list[str]) -> int:
    wanted = list(READERS) if not argv or argv == ['all'] else argv
    OUT.mkdir(parents=True, exist_ok=True)
    failed = 0
    for sample in wanted:
        if sample not in READERS:
            print(f'{sample}: unknown sample (one of {", ".join(READERS)})', file=sys.stderr)
            failed += 1
            continue
        try:
            started = time.time()
            result = {'sample': sample, **READERS[sample]()}
        except Exception as e:  # noqa: BLE001 - report and go on to the next sample
            print(f'{sample}: {e}', file=sys.stderr)
            failed += 1
            continue
        result['tables'] = sorted(result['tables'] or [], key=lambda t: ((t.get('schema') or ''), t['name']))
        # Small files: what the comparison reads, without defaults, index definitions or empty values.
        for t in result['tables']:
            t['columns'] = [{k: v for k, v in c.items() if v is not None and k not in DROPPED} for c in t['columns']]
        for u in result['uniqueKeys'] or []:
            u.pop('definition', None)
        for k in ('uniqueKeys', 'foreignKeys'):
            result[k] = sorted(result[k] or [], key=lambda x: ((x.get('schema') or ''), x['table'], x.get('name') or '', x['columns']))
        (OUT / f'{sample}.json').write_text(json.dumps(result, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
        cols = sum(len(t['columns']) for t in result['tables'])
        print(f"{sample}: {result['engine']}: {len(result['tables'])} tables, {cols} columns, "
              f"{len(result['foreignKeys'])} foreign keys, {len(result['errors'])} errors ({time.time() - started:.0f}s)")
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
