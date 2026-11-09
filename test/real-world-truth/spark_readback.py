"""Databricks read-back with Apache Spark's own SQL parser: run by readback.py in a Python
that has pyspark installed (4.3.0 here; the parser needs table-constraint support) (RWT_SPARK_PYTHON).
Prints one JSON object.

    <python> -I spark_readback.py <samples root> databricks-open-retail-data-model

Why the parser and not a catalog: open-source Spark's session catalog cannot hold
PRIMARY KEY / FOREIGN KEY constraints (they are Unity Catalog's), and Delta tables need
the Delta jars. So each statement goes through Spark's parser (`sqlParser.parsePlan`),
the grammar Databricks SQL extends, after Spark's own `${var}` substitution, and the
parsed plans are replayed: CREATE TABLE makes a table (columns, types, nullability,
comments, PRIMARY KEY / UNIQUE), ALTER TABLE ... ADD CONSTRAINT adds a key or a foreign
key to it. Each template variable is set to its own name (${store_schema} → store_schema),
so a table's schema is the variable that names it. A statement the parser rejects is
recorded (file, line, error); CHECK constraints and functions are parsed and set aside.

Spark's parser marks a PRIMARY KEY column NOT NULL, as Databricks does.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

VAR = re.compile(r'\$\{([A-Za-z_][A-Za-z0-9_]*)\}')


def split_statements(text: str) -> list[tuple[int, str]]:
    """(line, statement) for each ;-terminated statement: comments, quotes and backticks respected."""
    out: list[tuple[int, str]] = []
    i, n, start = 0, len(text), 0
    while i < n:
        c = text[i]
        if text.startswith('--', i):
            j = text.find('\n', i)
            i = n if j < 0 else j + 1
            continue
        if text.startswith('/*', i):
            j = text.find('*/', i + 2)
            i = n if j < 0 else j + 2
            continue
        if c in ("'", '"', '`'):
            j = i + 1
            while j < n and text[j] != c:
                j += 2 if text[j] == '\\' else 1
            i = j + 1
            continue
        if c == ';':
            out.append((start, text[start:i]))
            start = i + 1
        i += 1
    if text[start:].strip():
        out.append((start, text[start:]))
    result = []
    for at, stmt in out:
        # The statement starts at its first line of code (after comments and blank lines).
        lines = stmt.split('\n')
        skip = 0
        for l in lines:
            s = l.strip()
            if s and not s.startswith('--'):
                break
            skip += 1
        code = '\n'.join(lines[skip:]).strip()
        if code:
            result.append((text.count('\n', 0, at) + 1 + skip, code))
    return result


def seq(js: str) -> list[str]:
    """Spark's toJSON renders a Seq as "[a, b]"."""
    inner = js.strip()[1:-1].strip()
    return [p.strip() for p in inner.split(',')] if inner else []


def first_line(msg: str) -> str:
    for line in str(msg).splitlines():
        line = line.strip()
        if line and not line.startswith('Traceback'):
            return ' '.join(line.split())[:200]
    return 'parse error'


def main(root: str, sample: str) -> None:
    from pyspark.sql import SparkSession

    spark = (SparkSession.builder.master('local[1]').appName('rwt')
             .config('spark.ui.enabled', 'false').config('spark.sql.variable.substitute', 'true').getOrCreate())
    spark.sparkContext.setLogLevel('ERROR')
    parser = spark._jsparkSession.sessionState().sqlParser()
    substitution = spark._jvm.org.apache.spark.sql.internal.VariableSubstitution()

    root_path = Path(root)
    files = sorted((root_path / sample / 'canonical-core').rglob('*.sql'))
    statements = []
    for f in files:
        text = f.read_text(encoding='utf-8')
        for var in sorted(set(VAR.findall(text))):
            spark.conf.set(var, var)
        for line, code in split_statements(text):
            statements.append((f.relative_to(root_path).as_posix(), line, code))

    tables: dict[tuple[str, str], dict] = {}
    unique_keys: list[dict] = []
    foreign_keys: list[dict] = []
    errors: list[dict] = []
    set_aside: dict[str, int] = {}
    pending: list[tuple[dict, dict, list]] = []

    def parse(where: dict, code: str):
        try:
            return json.loads(parser.parsePlan(substitution.substitute(code)).toJSON())
        except Exception as e:  # noqa: BLE001 - every failure is recorded
            words = code.split(None, 3)
            errors.append({**where, 'statement': ' '.join(words[:3]), 'error': first_line(e)})
            return None

    # CREATE TABLEs first, then the ALTERs (a deployment runs tables/ before relationships.sql).
    for file, line, code in statements:
        where = {'file': file, 'line': line}
        nodes = parse(where, code)
        if nodes is None:
            continue
        kind = nodes[0]['class'].rsplit('.', 1)[-1]
        if kind in ('CreateTable', 'ReplaceTable'):
            ident = next(n for n in nodes if n['class'].endswith('UnresolvedIdentifier'))
            parts = seq(ident['nameParts'])
            # toJSON nests the table spec (and its constraints) inside the CreateTable node.
            spec_nodes = nodes[0].get('tableSpec') or []
            spec = next((n for n in spec_nodes if n['class'].endswith('TableSpec')), {})
            t = {'catalog': parts[0] if len(parts) == 3 else None, 'schema': parts[-2] if len(parts) > 1 else None,
                 'name': parts[-1], 'comment': spec.get('comment'), 'pk': None, 'columns': []}
            for col in nodes[0]['columns']:
                c = col[0]
                t['columns'].append({'name': c['name'], 'type': c['dataType'], 'notNull': not c['nullable'],
                                     'identity': 'identityColumnSpec' in c, 'comment': c.get('comment')})
            tables[(t['schema'], t['name'])] = t
            for n in spec_nodes:
                cls = n['class'].rsplit('.', 1)[-1]
                if cls == 'PrimaryKeyConstraint':
                    t['pk'] = seq(n['columns'])
                elif cls == 'UniqueConstraint':
                    unique_keys.append({'schema': t['schema'], 'table': t['name'], 'name': n.get('userProvidedName'),
                                        'kind': 'constraint', 'partial': False, 'columns': seq(n['columns'])})
                elif cls == 'ForeignKeyConstraint':
                    pending.append((where, {'table': t, 'fk': n}, []))
        elif kind == 'AddConstraint':
            pending.append((where, {'nodes': nodes}, []))
        else:
            set_aside[kind] = set_aside.get(kind, 0) + 1

    for where, item, _ in pending:
        if 'nodes' in item:
            nodes = item['nodes']
            target = seq(next(n for n in nodes if n['class'].endswith('UnresolvedTable'))['multipartIdentifier'])
            t = tables.get((target[-2] if len(target) > 1 else None, target[-1]))
            con = nodes[0]['tableConstraint'][0]
        else:
            t, con = item['table'], item['fk']
        cls = con['class'].rsplit('.', 1)[-1]
        if t is None:
            errors.append({**where, 'statement': 'ALTER TABLE', 'error': 'the table is not created by any statement'})
            continue
        if cls == 'PrimaryKeyConstraint':
            t['pk'] = seq(con['columns'])
        elif cls == 'UniqueConstraint':
            unique_keys.append({'schema': t['schema'], 'table': t['name'], 'name': con.get('userProvidedName'),
                                'kind': 'constraint', 'partial': False, 'columns': seq(con['columns'])})
        elif cls == 'ForeignKeyConstraint':
            parent = seq(con['parentTableId'])
            foreign_keys.append({'schema': t['schema'], 'table': t['name'], 'name': con.get('userProvidedName'),
                                 'columns': seq(con['childColumns']),
                                 'refSchema': parent[-2] if len(parent) > 1 else None, 'refTable': parent[-1],
                                 'refColumns': seq(con['parentColumns'])})
        else:
            set_aside[cls] = set_aside.get(cls, 0) + 1

    out = {
        'engine': f'Apache Spark {spark.version} SQL parser (no catalog)',
        'loaded': [f.relative_to(root_path).as_posix() for f in files],
        'statementsParsed': len(statements) - len(errors),
        'setAside': dict(sorted(set_aside.items())),
        'errors': errors,
        'tables': sorted(tables.values(), key=lambda t: (t['schema'] or '', t['name'])),
        'uniqueKeys': unique_keys,
        'foreignKeys': sorted(foreign_keys, key=lambda k: (k['schema'] or '', k['table'], k['name'] or '')),
    }
    spark.stop()
    print(json.dumps(out))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
