"""Snowflake read-back with fakesnow (a Snowflake emulator on DuckDB): run by readback.py
in a Python that has fakesnow installed (RWT_SNOWFLAKE_PYTHON). Prints one JSON object.

    <python> -I snowflake_readback.py <samples root> <sample> [--setup <sql>]... [file ...]

The files (paths under the sample's folder) are loaded in the order given; with none,
every .sql file under the sample's scripts/ folder, in name order. Statements are split by the Snowflake connector's own splitter and sent one at a time;
one that fails is recorded (file, line, error) and the load goes on. Columns, types,
nullability and comments come from fakesnow's INFORMATION_SCHEMA (Snowflake's names);
primary, unique and foreign keys from DuckDB's duckdb_constraints(), which holds what the
CREATE TABLE declared.

DuckDB cannot hold two things Snowflake can, so a CREATE TABLE that fails on them is run
again without them and they are read from sqlglot's Snowflake parse of the statement
(sqlglot is fakesnow's own parser), marked "via": "sqlglot" and listed in "workarounds":
- a foreign key to a table in another schema ("Creating foreign keys across different
  schemas or catalogs is not supported");
- a VECTOR(FLOAT, n) column ("Expected a constant as type modifier"): created as ARRAY,
  its declared type kept from the parse;
- a foreign key to a table created later in the script (Snowflake does not check that the
  referenced table exists; DuckDB does: "Table with name X does not exist");
- CREATE TABLE t (column list) AS SELECT ("Invalid column definition list"): created from the
  column list alone, which is what sets the table's columns (the query fills its rows).

fakesnow also drops every column COMMENT; those are read from the parse of the statement that
ran, marked "commentVia": "sqlglot".
"""
from __future__ import annotations

import io
import json
import sys
import warnings
from pathlib import Path

warnings.filterwarnings('ignore')

import fakesnow  # noqa: E402
import snowflake.connector  # noqa: E402
from snowflake.connector.util_text import split_statements  # noqa: E402
import sqlglot  # noqa: E402
from sqlglot import exp  # noqa: E402


def workaround(body: str, current_schema: str, existing: set[tuple[str, str]]) -> tuple[str, list[dict], dict[str, str], list[str]] | None:
    """The statement without what DuckDB cannot hold, plus what was taken out."""
    try:
        tree = sqlglot.parse_one(body, read='snowflake')
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(tree, exp.Create) or not isinstance(tree.this, exp.Schema):
        return None
    table = tree.this.this
    fks: list[dict] = []
    types: dict[str, str] = {}
    did: list[str] = []
    for fk in list(tree.find_all(exp.ForeignKey)):
        ref = fk.args['reference'].this
        # REFERENCES t (cols) parses as a Schema around the table; REFERENCES t (the primary key) as the table.
        ref_table = ref.this if isinstance(ref, exp.Schema) else ref
        ref_cols = ref.expressions if isinstance(ref, exp.Schema) else []
        ref_schema = ref_table.args.get('db')
        ref_key = (folded(ref_schema) if ref_schema is not None else current_schema.upper(), folded(ref_table.this))
        other_schema = ref_schema is not None and folded(ref_schema) != current_schema.upper()
        if other_schema or ref_key not in existing:
            node = fk.parent if isinstance(fk.parent, exp.Constraint) else fk
            name = node.this.name if isinstance(node, exp.Constraint) else None
            fks.append({'name': name, 'columns': [folded(c) for c in fk.expressions],
                        'refSchema': ref_key[0], 'refTable': ref_key[1],
                        'refColumns': [folded(c) for c in ref_cols], 'via': 'sqlglot'})
            node.pop()
            why = ('another schema, which DuckDB cannot reference' if other_schema
                   else 'a table created later, which DuckDB cannot reference yet')
            did.append(f'foreign key ({", ".join(c.name for c in fk.expressions)}) to {ref_key[0]}.{ref_key[1]}: {why}; read from the parse')
    for col in tree.find_all(exp.ColumnDef):
        kind = col.args.get('kind')
        if isinstance(kind, exp.DataType) and kind.this == exp.DataType.Type.VECTOR:
            types[folded(col.this)] = kind.sql('snowflake')
            col.set('kind', exp.DataType.build('ARRAY', dialect='snowflake'))
            did.append(f'{col.name} {types[folded(col.this)]}: DuckDB has no VECTOR; created as ARRAY, declared type from the parse')
    if tree.args.get('expression') is not None:
        # CREATE TABLE t (column list) AS SELECT: the columns are the list's; the query only fills rows.
        tree.set('expression', None)
        did.append('CREATE TABLE (column list) AS SELECT: DuckDB cannot take a column list with a query; '
                   'created from the column list (the query is data)')
    if not did:
        return None
    return tree.sql('snowflake'), fks, types, did


def folded(node) -> str:
    """An identifier as Snowflake stores it: quoted as written, unquoted upper-cased."""
    ident = node if isinstance(node, exp.Identifier) else node.this if isinstance(node, (exp.Column, exp.Table)) else node
    if isinstance(ident, exp.Identifier):
        return ident.name if ident.quoted else ident.name.upper()
    return node.name.upper()


def remember_comments(sql: str, cur, into: dict[tuple[str, str], dict[str, str]]) -> None:
    """A CREATE TABLE's column COMMENTs, from the parse: fakesnow drops them ("CommentColumnConstraint
    unsupported"), so they are read from sqlglot's Snowflake parse of the statement that ran."""
    try:
        tree = sqlglot.parse_one(sql, read='snowflake')
    except Exception:  # noqa: BLE001
        return
    if not isinstance(tree, exp.Create) or not isinstance(tree.this, exp.Schema):
        return
    target = tree.this.this
    if target.args.get('db') is not None:
        schema = folded(target.args['db'])
    else:
        cur.execute('select current_schema()')
        schema = cur.fetchone()[0]
    found = {}
    for col in tree.this.expressions:
        if isinstance(col, exp.ColumnDef):
            for c in col.constraints:
                if isinstance(c.kind, exp.CommentColumnConstraint):
                    found[folded(col.this)] = c.kind.this.name
    if found:
        into[(schema, folded(target.this))] = found


def short(msg: str, limit: int = 200) -> str:
    msg = ' '.join(str(msg).split())
    return msg if len(msg) <= limit else msg[: limit - 1] + '…'


def main(root: str, sample: str, wanted: list[str], setup: list[str]) -> None:
    root_path = Path(root)
    files = [root_path / sample / w for w in wanted] if wanted else sorted((root_path / sample / 'scripts').glob('*.sql'))
    errors: list[dict] = []
    workarounds: list[dict] = []
    parsed_fks: dict[tuple[str, str], list[dict]] = {}
    parsed_types: dict[tuple[str, str], dict[str, str]] = {}
    parsed_comments: dict[tuple[str, str], dict[str, str]] = {}
    ok = 0
    with fakesnow.patch():
        conn = snowflake.connector.connect(database='SAMPLE', schema='PUBLIC')
        cur = conn.cursor()
        for stmt in setup:  # what the script expects to exist already (readback.py names it)
            cur.execute(stmt)
        for f in files:
            text = f.read_text(encoding='utf-8')
            pos = 0
            for stmt, _is_put_get in split_statements(io.StringIO(text), remove_comments=False):
                body = stmt.strip()
                at = text.find(body, pos) if body else -1
                if at >= 0:
                    pos = at + len(body)
                # Only comments: nothing to run.
                code = '\n'.join(l for l in body.splitlines() if not l.strip().startswith('--')).strip().rstrip(';').strip()
                if not code:
                    continue
                # The statement's line is its first line of code, after any comments before it.
                lead = 0
                for l in body.splitlines():
                    if l.strip() and not l.strip().startswith('--'):
                        break
                    lead += 1
                line = text.count('\n', 0, at) + 1 + lead if at >= 0 else 0
                where = {'file': f.relative_to(root_path).as_posix(), 'line': line}
                try:
                    cur.execute(body)
                    ok += 1
                    remember_comments(body, cur, parsed_comments)
                    continue
                except Exception as e:  # noqa: BLE001 - every failure is recorded
                    failure = short(e)
                cur.execute('select current_schema()')
                schema = cur.fetchone()[0]
                cur.execute("select table_schema, table_name from information_schema.tables where table_type = 'BASE TABLE'")
                existing = {(a, b) for a, b in cur.fetchall()}
                again = workaround(body, schema, existing) if 'CREATE' in code.upper().split('(')[0] else None
                if again:
                    sql, fks, types, did = again
                    try:
                        cur.execute(sql)
                        ok += 1
                        remember_comments(sql, cur, parsed_comments)
                        target = sqlglot.parse_one(sql, read='snowflake').this.this
                        tschema = folded(target.args['db']) if target.args.get('db') is not None else schema.upper()
                        name = folded(target.this)
                        parsed_fks.setdefault((tschema, name), []).extend(fks)
                        parsed_types.setdefault((tschema, name), {}).update(types)
                        workarounds.append({**where, 'engineError': failure, 'did': did})
                        continue
                    except Exception as e2:  # noqa: BLE001
                        failure = f'{failure}; without them: {short(e2)}'
                first = code.split(None, 3)
                errors.append({**where, 'statement': ' '.join(first[:3]), 'error': failure})
        # The catalog, Snowflake side (fakesnow's information_schema).
        cur.execute("""
            select t.table_schema, t.table_name, t.comment
            from information_schema.tables t
            where t.table_type = 'BASE TABLE' and t.table_schema <> 'INFORMATION_SCHEMA'
            order by 1, 2""")
        tables = [{'schema': s, 'name': n, 'comment': c, 'pk': None, 'columns': []} for s, n, c in cur.fetchall()]
        by_key = {(t['schema'], t['name']): t for t in tables}
        cur.execute("""
            select table_schema, table_name, column_name, data_type, character_maximum_length,
                   numeric_precision, numeric_scale, is_nullable, column_default, comment
            from information_schema.columns
            order by table_schema, table_name, ordinal_position""")
        for s, n, col, dt, clen, prec, scale, nullable, default, comment in cur.fetchall():
            t = by_key.get((s, n))
            if not t:
                continue
            typ = dt
            if dt == 'NUMBER' and prec is not None:
                typ = f'NUMBER({prec},{scale})'
            elif dt == 'TEXT' and clen is not None:
                typ = f'VARCHAR({clen})'
            declared = parsed_types.get((s, n), {}).get(col)
            said = parsed_comments.get((s, n), {}).get(col) if comment is None else None
            t['columns'].append({'name': col, 'type': declared or typ, **({'typeVia': 'sqlglot'} if declared else {}),
                                 'notNull': nullable == 'NO', 'default': default, 'comment': said if said is not None else comment,
                                 **({'commentVia': 'sqlglot'} if said is not None else {})})
        # Keys, DuckDB side.
        duck = cur._duck_conn  # fakesnow's DuckDB connection
        rows = duck.execute("""
            select schema_name, table_name, constraint_type, constraint_name, constraint_column_names,
                   referenced_table, referenced_column_names
            from duckdb_constraints()
            where schema_name not like '_fs_%' and constraint_type in ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')
            order by 1, 2, 4""").fetchall()
        unique_keys, foreign_keys = [], []
        for s, n, kind, name, cols, ref_table, ref_cols in rows:
            t = by_key.get((s, n)) or by_key.get((s.upper(), n.upper()))
            if not t:
                continue
            # As stored: fakesnow upper-cases an unquoted name and keeps a quoted one as written.
            cols = list(cols)
            if kind == 'PRIMARY KEY':
                t['pk'] = cols
            elif kind == 'UNIQUE':
                unique_keys.append({'schema': t['schema'], 'table': t['name'], 'name': name, 'kind': 'constraint', 'partial': False, 'columns': cols})
            else:
                # DuckDB records the referenced table without its schema; find it among the loaded ones.
                ref = [k for k in by_key if k[1] == ref_table]
                ref_schema = ref[0][0] if len(ref) == 1 else None
                foreign_keys.append({'schema': t['schema'], 'table': t['name'], 'name': name, 'columns': cols,
                                     'refSchema': ref_schema, 'refTable': ref_table, 'refColumns': list(ref_cols)})
    for (s, n), fks in parsed_fks.items():
        for fk in fks:
            if not fk['refColumns']:
                # REFERENCES t with no column list names t's primary key, as Snowflake reads it.
                target = by_key.get((fk['refSchema'], fk['refTable']))
                fk = {**fk, 'refColumns': list(target['pk'] or []) if target else []}
            foreign_keys.append({'schema': s, 'table': n, **fk})
    foreign_keys.sort(key=lambda k: (k['schema'], k['table'], k['name'] or '', k['columns']))
    version = f"fakesnow {fakesnow_version()} (Snowflake emulator on DuckDB {duck_version()})"
    print(json.dumps({'engine': version, 'loaded': [f.relative_to(root_path).as_posix() for f in files], **({'setup': setup} if setup else {}),
                      'statementsRun': ok, 'workarounds': workarounds, 'errors': errors, 'tables': tables,
                      'uniqueKeys': unique_keys, 'foreignKeys': foreign_keys}))


def fakesnow_version() -> str:
    from importlib.metadata import version
    return version('fakesnow')


def duck_version() -> str:
    import duckdb
    return duckdb.__version__


def args(rest: list[str]) -> tuple[list[str], list[str]]:
    """(files, setup statements) from `[--setup <sql>]... [file]...`."""
    files, setup, i = [], [], 0
    while i < len(rest):
        if rest[i] == '--setup':
            setup.append(rest[i + 1])
            i += 2
        else:
            files.append(rest[i])
            i += 1
    return files, setup


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], *args(sys.argv[3:]))
