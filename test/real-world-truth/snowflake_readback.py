"""Snowflake read-back with fakesnow (a Snowflake emulator on DuckDB): run by readback.py
in a Python that has fakesnow installed (RWT_SNOWFLAKE_PYTHON). Prints one JSON object.

    <python> -I snowflake_readback.py <samples root> snowflake-grid-reliability

Statements are split by the Snowflake connector's own splitter and sent one at a time;
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
  its declared type kept from the parse.
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


def workaround(body: str, current_schema: str) -> tuple[str, list[dict], dict[str, str], list[str]] | None:
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
        ref_schema = ref.this.args.get('db')
        if ref_schema is not None and ref_schema.name.upper() != current_schema.upper():
            node = fk.parent if isinstance(fk.parent, exp.Constraint) else fk
            name = node.this.name if isinstance(node, exp.Constraint) else None
            fks.append({'name': name, 'columns': [c.name.upper() for c in fk.expressions],
                        'refSchema': ref_schema.name.upper(), 'refTable': ref.this.name.upper(),
                        'refColumns': [c.name.upper() for c in ref.expressions], 'via': 'sqlglot'})
            node.pop()
            did.append(f'foreign key ({", ".join(c.name for c in fk.expressions)}) to {ref_schema.name}.{ref.this.name}: '
                       'another schema, which DuckDB cannot reference; read from the parse')
    for col in tree.find_all(exp.ColumnDef):
        kind = col.args.get('kind')
        if isinstance(kind, exp.DataType) and kind.this == exp.DataType.Type.VECTOR:
            types[col.name.upper()] = kind.sql('snowflake')
            col.set('kind', exp.DataType.build('ARRAY', dialect='snowflake'))
            did.append(f'{col.name} {types[col.name.upper()]}: DuckDB has no VECTOR; created as ARRAY, declared type from the parse')
    if not did:
        return None
    return tree.sql('snowflake'), fks, types, did


def short(msg: str, limit: int = 200) -> str:
    msg = ' '.join(str(msg).split())
    return msg if len(msg) <= limit else msg[: limit - 1] + '…'


def main(root: str, sample: str) -> None:
    root_path = Path(root)
    files = sorted((root_path / sample / 'scripts').glob('*.sql'))
    errors: list[dict] = []
    workarounds: list[dict] = []
    parsed_fks: dict[tuple[str, str], list[dict]] = {}
    parsed_types: dict[tuple[str, str], dict[str, str]] = {}
    ok = 0
    with fakesnow.patch():
        conn = snowflake.connector.connect(database='SAMPLE', schema='PUBLIC')
        cur = conn.cursor()
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
                    continue
                except Exception as e:  # noqa: BLE001 - every failure is recorded
                    failure = short(e)
                cur.execute('select current_schema()')
                schema = cur.fetchone()[0]
                again = workaround(body, schema) if 'CREATE' in code.upper().split('(')[0] else None
                if again:
                    sql, fks, types, did = again
                    try:
                        cur.execute(sql)
                        ok += 1
                        name = sqlglot.parse_one(sql, read='snowflake').this.this.name.upper()
                        parsed_fks.setdefault((schema.upper(), name), []).extend(fks)
                        parsed_types.setdefault((schema.upper(), name), {}).update(types)
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
            t['columns'].append({'name': col, 'type': declared or typ, **({'typeVia': 'sqlglot'} if declared else {}),
                                 'notNull': nullable == 'NO', 'default': default, 'comment': comment})
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
            t = by_key.get((s.upper(), n.upper())) or by_key.get((s, n))
            if not t:
                continue
            cols = [c.upper() for c in cols]
            if kind == 'PRIMARY KEY':
                t['pk'] = cols
            elif kind == 'UNIQUE':
                unique_keys.append({'schema': t['schema'], 'table': t['name'], 'name': name, 'kind': 'constraint', 'partial': False, 'columns': cols})
            else:
                # DuckDB records the referenced table without its schema; find it among the loaded ones.
                ref = [k for k in by_key if k[1] == ref_table.upper()]
                ref_schema = ref[0][0] if len(ref) == 1 else None
                foreign_keys.append({'schema': t['schema'], 'table': t['name'], 'name': name, 'columns': cols,
                                     'refSchema': ref_schema, 'refTable': ref_table.upper(), 'refColumns': [c.upper() for c in ref_cols]})
    for (s, n), fks in parsed_fks.items():
        foreign_keys.extend({'schema': s, 'table': n, **fk} for fk in fks)
    foreign_keys.sort(key=lambda k: (k['schema'], k['table'], k['name'] or '', k['columns']))
    version = f"fakesnow {fakesnow_version()} (Snowflake emulator on DuckDB {duck_version()})"
    print(json.dumps({'engine': version, 'loaded': [f.relative_to(root_path).as_posix() for f in files],
                      'statementsRun': ok, 'workarounds': workarounds, 'errors': errors, 'tables': tables,
                      'uniqueKeys': unique_keys, 'foreignKeys': foreign_keys}))


def fakesnow_version() -> str:
    from importlib.metadata import version
    return version('fakesnow')


def duck_version() -> str:
    import duckdb
    return duckdb.__version__


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
