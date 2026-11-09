#!/usr/bin/env python3
"""
Counts what each corpus schema holds, without ERD Studio: the "source truth"
the corpus scorer compares the import with (tables, columns, primary keys,
unique keys, foreign keys, descriptions).

    python3 -I scripts/corpus/count_source.py --cache .cache/import-corpus [--only a,b]

Writes <cache>/truth/<name>.json in the shape of the real-world scorecard's
expected.json samples (test/unit/realWorldScorecard.ts, TruthSample), plus
`method` and `approximate` notes saying how each count was made.

How it counts (independently of the importer, which uses @dbml/core's ANTLR
grammars):
- SQL: a statement splitter of its own (quotes, comments, dollar quotes, GO
  and Oracle `/` batches, pg_dump COPY data, psql meta-commands), then sqlglot
  (pinned in requirements.txt) in the source's own dialect for CREATE TABLE,
  ALTER TABLE ... ADD, CREATE UNIQUE INDEX and COMMENT ON. A statement sqlglot
  cannot read falls back to a small structural reader (the table name and the
  top-level items of its column list) and is listed under `approximate`.
  PostgreSQL partitions (PARTITION OF, ATTACH PARTITION) are folded into
  their parent, as the import's default does. SQL Server descriptions come
  from sp_addextendedproperty MS_Description; MySQL from COMMENT; BigQuery
  from OPTIONS(description=...).
- dbt: the models' yml (columns, unique + not_null tests as the key,
  relationships and relationships_where tests).
- Power BI: TMDL (table / column / relationship blocks) or model.bim JSON.
- Rails schema.rb: create_table / t.<type> / add_foreign_key, by regex.

The files are untrusted data: this only reads them as text. Run it with
`python3 -I` (isolated mode), from outside the cache.
"""
import argparse
import json
import logging
import os
import re
import sys

try:
    import sqlglot
    from sqlglot import exp
except ImportError:  # the SQL counts need it; the others do not
    sqlglot = None
try:
    import yaml
except ImportError:
    yaml = None

logging.getLogger('sqlglot').setLevel(logging.ERROR)
HERE = os.path.dirname(os.path.abspath(__file__))
SQLGLOT_DIALECT = {
    'postgres': 'postgres', 'mysql': 'mysql', 'sqlserver': 'tsql', 'oracle': 'oracle', 'bigquery': 'bigquery',
    'redshift': 'redshift', 'sqlite': 'sqlite', 'snowflake': 'snowflake', 'databricks': 'databricks', 'ansi': 'postgres',
}


def unquote(s):
    s = s.strip()
    if len(s) >= 2 and ((s[0] == s[-1] and s[0] in '"`\'') or (s[0] == '[' and s[-1] == ']')):
        return s[1:-1]
    return s


# ---------------------------------------------------------------------------
# SQL: text → statements
# ---------------------------------------------------------------------------

STMT_START = re.compile(
    r'(CREATE\s+(OR\s+REPLACE\s+)?((GLOBAL|LOCAL)\s+)?((TEMP|TEMPORARY|UNLOGGED|EXTERNAL|TRANSIENT|VOLATILE|MULTISET|SET)\s+)*TABLE'
    r'|CREATE\s+(UNIQUE\s+)?((CLUSTERED|NONCLUSTERED|BITMAP)\s+)?INDEX'
    r'|ALTER\s+TABLE|COMMENT\s+ON|EXEC(UTE)?\s+(sys\.)?sp_addextendedproperty'
    r'|CREATE\s+(OR\s+REPLACE\s+)?(PROCEDURE|PROC|FUNCTION|TRIGGER|VIEW|TYPE|SEQUENCE|SCHEMA|PACKAGE)'
    r'|INSERT\s+INTO|DROP\s+|GRANT\s+|SET\s+|USE\s+|BEGIN\b|DECLARE\b|PRINT\b|IF\s)', re.I)


def preprocess(text, dialect):
    """Data and client commands out; batch separators to `;`; MySQL conditional comments opened. Line count kept."""
    text = text.lstrip('﻿').replace('\r\n', '\n').replace('\r', '\n')
    out = []
    in_copy = False
    for line in text.split('\n'):
        if in_copy:
            out.append('')
            if line.strip() == '\\.':
                in_copy = False
            continue
        if re.match(r'\s*COPY\s+\S+.*\bFROM\s+stdin\s*;', line, re.I):
            in_copy = True
            out.append('')
            continue
        if line.startswith('\\'):
            out.append('')
            continue
        if re.match(r'\s*GO\s*(\d+\s*)?$', line, re.I) or (dialect == 'oracle' and line.strip() == '/'):
            out.append(';')
            continue
        out.append(line)
    text = '\n'.join(out)
    # /*!50705 location GEOMETRY */ is SQL that MySQL runs.
    text = re.sub(r'/\*!\d*(.*?)\*/', lambda m: ' ' + m.group(1) + ' ', text, flags=re.S)
    # Template placeholders: @cdmDatabaseSchema.person → cdmDatabaseSchema.person, ${catalog} → catalog.
    text = re.sub(r'@(\w+)\.', r' \1.', text)
    text = re.sub(r'\$\{(\w+)\}', r'\1', text)
    return text


def split_statements(text, dialect):
    """(line, text) for each top-level statement: `;` outside quotes and comments, or a new statement at the start of a line."""
    stmts = []
    i, n = 0, len(text)
    start, line, start_line = 0, 1, 1
    depth = 0
    mysql = dialect in ('mysql',)
    buf_has_code = False

    def push(end):
        nonlocal start, start_line
        s = text[start:end]
        if s.strip():
            # the line of the first non-blank, non-comment character
            m = re.search(r'\S', s)
            lead = s[:m.start()] if m else ''
            stmts.append((start_line + lead.count('\n'), s))
        start = end + 1

    while i < n:
        c = text[i]
        if c == '\n':
            line += 1
            if depth == 0 and buf_has_code:
                k = i + 1
                while k < n and text[k] in ' \t':
                    k += 1
                m = STMT_START.match(text, k)
                if m and m.group(0)[:1].upper() in ('C', 'A', 'E') and re.match(r'(CREATE|ALTER|COMMENT|EXEC)', m.group(0), re.I):
                    push(i)
                    start_line = line
                    buf_has_code = False
            i += 1
            continue
        if c == '-' and text.startswith('--', i):
            j = text.find('\n', i)
            i = n if j < 0 else j
            continue
        if c == '#' and mysql and (i == 0 or text[i - 1] in ' \n\t'):
            j = text.find('\n', i)
            i = n if j < 0 else j
            continue
        if c == '/' and text.startswith('/*', i):
            j = text.find('*/', i + 2)
            j = n if j < 0 else j + 2
            line += text.count('\n', i, j)
            i = j
            continue
        if c in ("'", '"', '`') or c == '[' and dialect in ('sqlserver', 'sqlite'):
            close = ']' if c == '[' else c
            j = i + 1
            while j < n:
                if text[j] == '\\' and mysql and c != '`':
                    j += 2
                    continue
                if text[j] == close:
                    if j + 1 < n and text[j + 1] == close and close != ']':
                        j += 2
                        continue
                    break
                j += 1
            line += text.count('\n', i, j)
            i = j + 1
            buf_has_code = True
            continue
        if c == '$' and dialect in ('postgres', 'redshift', 'ansi', 'snowflake'):
            m = re.match(r'\$(\w*)\$', text[i:i + 64])
            if m:
                tag = m.group(0)
                j = text.find(tag, i + len(tag))
                j = n if j < 0 else j + len(tag)
                line += text.count('\n', i, j)
                i = j
                continue
        if c == '(':
            depth += 1
        elif c == ')':
            depth = max(0, depth - 1)
        elif c == ';':
            push(i)
            start_line = line
            depth = 0
            buf_has_code = False
            i += 1
            continue
        if not c.isspace():
            buf_has_code = True
        i += 1
    push(n)
    return stmts


def strip_comments(s):
    s = re.sub(r'/\*.*?\*/', ' ', s, flags=re.S)
    return re.sub(r'--[^\n]*', ' ', s)


# ---------------------------------------------------------------------------
# SQL: statements → model
# ---------------------------------------------------------------------------

class Model:
    def __init__(self):
        self.tables = {}  # key (lower name) → dict
        self.order = []
        self.fks = []  # (from, [cols], to, [cols] or None, name)
        self.uniques = []  # (table, [cols], index)
        self.partitions = set()
        self.parent = {}  # partition (lower) → its parent's name
        self.partial_uniques = 0
        self.approx = []
        self.comments = []  # (table, column or None, text)

    def table(self, name, schema=None, create=True):
        k = name.lower()
        if k not in self.tables:
            if not create:
                return None
            self.tables[k] = {'name': name, 'schema': schema, 'columns': [], 'pk': [], 'description': None}
            self.order.append(k)
        return self.tables[k]


def ident(e):
    if e is None:
        return None
    if isinstance(e, exp.Identifier):
        return e.this
    if isinstance(e, exp.Column):
        return e.name
    if isinstance(e, exp.Ordered):
        return ident(e.this)
    if isinstance(e, exp.Table):
        return e.name
    if isinstance(e, exp.Literal):
        return e.this
    return getattr(e, 'name', None) or e.sql()


def cols_of(exprs):
    out = []
    for e in exprs or []:
        # A key's column without its order, operator class or collation (`name text_pattern_ops DESC`).
        while isinstance(e, (exp.Ordered, exp.Opclass, exp.Collate)) and isinstance(e.this, (exp.Ordered, exp.Opclass, exp.Collate, exp.Column, exp.Identifier)):
            e = e.this
        prefix = re.match(r'^[`"\[]?(\w+)[`"\]]?\s*\(\s*\d+\s*\)$', e.sql()) if not isinstance(e, (exp.Ordered, exp.Column, exp.Identifier)) else None
        if prefix:
            out.append(prefix.group(1))  # MySQL's key on a column's prefix, `plan`(20): that column
        elif isinstance(e, (exp.Ordered, exp.Column, exp.Identifier)):
            out.append(ident(e))
        elif isinstance(e, exp.Paren):
            out.append(e.sql())
        else:
            out.append(e.sql())
    return out


def ref_target(ref):
    """Reference → (table, schema, [cols] or None)."""
    t = ref.this
    if isinstance(t, exp.Schema):
        tbl = t.this
        return ident(tbl), (tbl.args.get('db').name if isinstance(tbl, exp.Table) and tbl.args.get('db') else None), [ident(c) for c in t.expressions] or None
    if isinstance(t, exp.Table):
        return t.name, (t.args.get('db').name if t.args.get('db') else None), None
    return ident(t), None, None


def apply_constraint(m, table, c, name=None):
    """A table-level constraint (PrimaryKey, ForeignKey, Unique…) on `table`."""
    if isinstance(c, exp.Constraint):
        kinds = [x.kind if isinstance(x, exp.ColumnConstraint) else x for x in c.expressions]
        listed = [x for x in kinds if isinstance(x, (exp.ClusteredColumnConstraint, exp.NonClusteredColumnConstraint))]
        if listed and any(isinstance(x, (exp.PrimaryKeyColumnConstraint, exp.UniqueColumnConstraint)) for x in kinds):
            cols = cols_of(listed[0].this if isinstance(listed[0].this, list) else listed[0].expressions)
            if any(isinstance(x, exp.PrimaryKeyColumnConstraint) for x in kinds):
                table['pk'] = cols
            else:
                m.uniques.append((table['name'], cols, False))
            return
        for x in c.expressions:
            apply_constraint(m, table, x, ident(c.this))
        return
    if isinstance(c, exp.PrimaryKey):
        table['pk'] = cols_of(c.expressions)
    elif isinstance(c, exp.ForeignKey):
        ref = c.args.get('reference')
        if ref is not None:
            to, _s, to_cols = ref_target(ref)
            m.fks.append((table['name'], cols_of(c.expressions), to, to_cols, name))
    elif isinstance(c, exp.UniqueColumnConstraint):
        if isinstance(c.this, (exp.ClusteredColumnConstraint, exp.NonClusteredColumnConstraint)) and isinstance(c.this.this, list):
            cols = cols_of(c.this.this)  # SQL Server: UNIQUE NONCLUSTERED ([a] ASC, [b] ASC)
        else:
            cols = cols_of(c.this.expressions) if isinstance(c.this, exp.Schema) else ([ident(c.this)] if c.this is not None else [])
        if cols:
            m.uniques.append((table['name'], cols, False))
    elif isinstance(c, exp.ColumnConstraint):
        apply_constraint(m, table, c.kind, name)


def add_column(m, table, cd, dialect):
    name = ident(cd.this)
    kind = cd.args.get('kind')
    # sqlglot reads SQL Server's inline `INDEX [ix] NONCLUSTERED ([c])` as a column INDEX of type ix: an index.
    if not cd.this.args.get('quoted') and name.upper() == 'INDEX' and kind is not None and kind.this == exp.DataType.Type.USERDEFINED:
        return
    typ = kind.sql(dialect=dialect) if kind is not None else ''
    if re.match(r'(ENUM|SET)\s*\(', typ, re.I):
        typ = typ.split('(')[0].strip().upper()  # its values are not a size: compared as the bare type
    flags = ''
    desc = None
    kinds = [cc.kind if isinstance(cc, exp.ColumnConstraint) else cc for cc in cd.args.get('constraints') or []]
    listed = [k for k in kinds if isinstance(k, (exp.ClusteredColumnConstraint, exp.NonClusteredColumnConstraint)) and isinstance(k.this, list)]
    if listed and any(isinstance(k, (exp.PrimaryKeyColumnConstraint, exp.UniqueColumnConstraint)) for k in kinds):
        # SQL Server: `[RevisionDate] DATETIME2 NOT NULL CONSTRAINT [PK] PRIMARY KEY CLUSTERED ([Id])` (no comma
        # before CONSTRAINT) is a table constraint on the listed columns, not on this column.
        cols = cols_of(listed[0].this)
        if any(isinstance(k, exp.PrimaryKeyColumnConstraint) for k in kinds):
            table['pk'] = cols
        else:
            m.uniques.append((table['name'], cols, False))
        cd.set('constraints', [cc for cc in cd.args.get('constraints') or [] if not isinstance(cc.kind if isinstance(cc, exp.ColumnConstraint) else cc, (exp.PrimaryKeyColumnConstraint, exp.UniqueColumnConstraint, exp.ClusteredColumnConstraint, exp.NonClusteredColumnConstraint))])
    for cc in cd.args.get('constraints') or []:
        k = cc.kind if isinstance(cc, exp.ColumnConstraint) else cc
        if isinstance(k, exp.NotNullColumnConstraint) and not k.args.get('allow_null'):
            flags += 'N'
        elif isinstance(k, exp.PrimaryKeyColumnConstraint):
            table['pk'] = [name]
        elif isinstance(k, exp.UniqueColumnConstraint):
            flags += 'U'
            m.uniques.append((table['name'], [name], False))
        elif isinstance(k, exp.Reference):
            to, _s, to_cols = ref_target(k)
            m.fks.append((table['name'], [name], to, to_cols, None))
        elif isinstance(k, exp.CommentColumnConstraint):
            desc = ident(k.this)
        elif isinstance(k, exp.ComputedColumnConstraint):
            typ = typ or '(computed)'
            flags += 'C'
        elif isinstance(k, exp.Properties):
            for p in k.expressions:
                if isinstance(p, exp.Property) and ident(p.this).lower() == 'description':
                    desc = ident(p.args.get('value'))
    if not typ and dialect not in ('sqlite',):
        typ = ''
    table['columns'].append([name, typ, flags, desc])


def schema_of(tbl):
    return tbl.args.get('db').name if isinstance(tbl, exp.Table) and tbl.args.get('db') else None


def on_create_table(m, e, dialect, where):
    target = e.this
    tbl = target.this if isinstance(target, exp.Schema) else target
    name = ident(tbl)
    if not name or name.startswith('#') or name.startswith('@'):
        return
    props = e.args.get('properties')
    if props is not None:
        for p in props.expressions:
            if isinstance(p, exp.PartitionedOfProperty):
                m.partitions.add(name.lower())
                m.parent[name.lower()] = ident(p.this)
                return
            if isinstance(p, exp.SchemaCommentProperty):
                pass
    if name.lower() in m.tables:  # created again (a dump's DROP/CREATE, a migration): the later one counts
        m.order.remove(name.lower())
        del m.tables[name.lower()]
    t = m.table(name, schema_of(tbl))
    if not isinstance(target, exp.Schema):
        q = e.args.get('expression')
        if isinstance(q, exp.Select):
            # CREATE TABLE ... AS SELECT CAST(NULL AS integer) AS person_id, ...: the projections are the columns.
            for p in q.expressions:
                inner = p.this if isinstance(p, exp.Alias) else p
                typ = inner.args.get('to').sql(dialect=dialect) if isinstance(inner, (exp.Cast, exp.TryCast)) and inner.args.get('to') is not None else ''
                t['columns'].append([p.alias_or_name, typ, '', None])
            m.approx.append(f'{where}: {name} is CREATE TABLE ... AS SELECT: columns read from its select list')
        else:
            # No column list to count (CREATE TABLE ... AS a query, LIKE, CLONE): left out of the truth, and said so.
            m.order.remove(name.lower())
            del m.tables[name.lower()]
            m.approx.append(f'{where}: {name} has no column list (CREATE TABLE ... AS / LIKE / CLONE): not counted')
        return
    for item in target.expressions:
        if isinstance(item, exp.ColumnDef):
            add_column(m, t, item, dialect)
        else:
            apply_constraint(m, t, item)
    if props is not None:
        for p in props.expressions:
            if isinstance(p, exp.SchemaCommentProperty):
                t['description'] = ident(p.this)
            elif isinstance(p, exp.Property) and ident(p.this).lower() == 'description':
                t['description'] = ident(p.args.get('value'))


def on_alter(m, e, dialect, where):
    tbl = e.this
    name = ident(tbl)
    t = m.table(name, schema_of(tbl), create=False)
    if t is None:
        return
    for a in e.args.get('actions') or []:
        items = a.expressions if isinstance(a, (exp.AddConstraint, exp.Schema)) else [a]
        for c in items:
            if isinstance(c, exp.ColumnDef):
                add_column(m, t, c, dialect)
            else:
                apply_constraint(m, t, c)


def on_index(m, e):
    if not e.args.get('unique'):
        return
    if e.this.args.get('params') is not None and e.this.args['params'].args.get('where') is not None:
        m.partial_uniques += 1  # unique only where a condition holds: not a key
        return
    ix = e.this
    tbl = ix.args.get('table')
    params = ix.args.get('params')
    cols = cols_of(params.args.get('columns') if params is not None else [])
    if tbl is not None and cols:
        m.uniques.append((ident(tbl), cols, True))


def on_comment(m, e):
    kind = (e.args.get('kind') or '').upper()
    text = ident(e.args.get('expression'))
    target = e.this
    if kind == 'TABLE':
        m.comments.append((ident(target), None, text))
    elif kind == 'COLUMN' and isinstance(target, exp.Column):
        m.comments.append((ident(target.args.get('table')), target.name, text))


# A structural reader for a CREATE TABLE sqlglot cannot read: the name, and each top-level item of the column list.
CREATE_RE = re.compile(r'CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED|EXTERNAL|TRANSIENT|VOLATILE|MULTISET|SET)\s+)*TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:[`"\[]?[^\s(`"\[\]]+[`"\]]?\s*\.\s*)*[`"\[]?[^\s(`"\[\]]+[`"\]]?)\s*(\(|PARTITION\s+OF|AS\b|LIKE\b|$)', re.I | re.S)
IDENT = r'(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[\w$#@]+)'


def split_top(body):
    parts, depth, cur, q = [], 0, [], None
    for ch in body:
        if q:
            cur.append(ch)
            if ch == q:
                q = None
            continue
        if ch in '\'"`':
            q = ch
        elif ch == '[' and not q:
            q = ']'
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch == ',' and depth == 0:
            parts.append(''.join(cur))
            cur = []
            continue
        cur.append(ch)
    parts.append(''.join(cur))
    return [p.strip() for p in parts if p.strip()]


def idents(s):
    return [unquote(x) for x in re.findall(IDENT, s)]


def index_columns(body, open_at):
    """An index's key list from its `(`: each key's column (ASC/DESC, NULLS FIRST, an
    opclass or COLLATE dropped); an expression key is kept as written, with its
    parentheses, so it is never compared as a column."""
    depth, q, end = 0, None, -1
    for i in range(open_at, len(body)):
        ch = body[i]
        if q:
            if ch == q:
                q = None
            continue
        if ch in '"\'`[':
            q = ']' if ch == '[' else ch
        elif ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
            if depth == 0:
                end = i
                break
    if end < 0:
        return None
    out = []
    for item in split_top(body[open_at + 1:end]):
        item = item.strip()
        if not item:
            continue
        if '(' in item:
            out.append(re.sub(r'\s+', ' ', item))
            continue
        names = idents(item)
        if names:
            out.append(names[0])
    return out


def structural_create(m, sql, where):
    s = strip_comments(sql)
    mm = CREATE_RE.search(s)
    if not mm:
        return False
    full = mm.group(1)
    parts = [unquote(p) for p in re.split(r'\s*\.\s*(?=(?:[^"`\]]|"[^"]*"|`[^`]*`|\[[^\]]*\])*$)', full)]
    name = parts[-1]
    if name.startswith('#') or name.startswith('@'):
        return True
    if mm.group(2).upper().startswith('PARTITION'):
        m.partitions.add(name.lower())
        pm = re.search(r'PARTITION\s+OF\s+((?:' + IDENT + r'\s*\.\s*)*' + IDENT + r')', s, re.I)
        if pm:
            m.parent[name.lower()] = idents(pm.group(1))[-1]
        return True
    if name.lower() in m.tables:
        m.order.remove(name.lower())
        del m.tables[name.lower()]
    t = m.table(name, parts[-2] if len(parts) > 1 else None)
    if mm.group(2) != '(':
        m.order.remove(name.lower())
        del m.tables[name.lower()]
        m.approx.append(f'{where}: {name} has no column list (CREATE TABLE ... AS / LIKE): not counted')
        return True
    start = mm.end() - 1
    depth, j = 0, start
    while j < len(s):
        if s[j] == '(':
            depth += 1
        elif s[j] == ')':
            depth -= 1
            if depth == 0:
                break
        j += 1
    body = s[start + 1:j]
    for item in split_top(body):
        head = item.split(None, 1)[0].upper() if item.split() else ''
        up = item.upper()
        cm = re.match(r'CONSTRAINT\s+' + IDENT + r'\s+(.*)$', item, re.I | re.S)
        rest = cm.group(1) if cm else item
        rup = rest.upper()
        if rup.startswith('PRIMARY KEY'):
            inside = re.search(r'\(([^)]*)\)', rest)
            if inside:
                t['pk'] = [c for c in idents(inside.group(1)) if c.upper() not in ('ASC', 'DESC')]
            continue
        if rup.startswith('FOREIGN KEY'):
            fm = re.match(r'FOREIGN\s+KEY\s*(?:' + IDENT + r'\s*)?\(([^)]*)\)\s*REFERENCES\s+((?:' + IDENT + r'\s*\.\s*)*' + IDENT + r')\s*(?:\(([^)]*)\))?', rest, re.I | re.S)
            if fm:
                m.fks.append((name, idents(fm.group(1)), idents(fm.group(2))[-1], idents(fm.group(3)) if fm.group(3) else None, None))
            continue
        if re.match(r'UNIQUE\b', rup):  # not a column named unique_device_id
            inside = re.search(r'\(([^)]*)\)', rest)
            if inside:
                m.uniques.append((name, [c for c in idents(inside.group(1)) if c.upper() not in ('ASC', 'DESC')], False))
            continue
        if cm or re.match(r'((FULLTEXT|SPATIAL|UNIQUE)\s+)?(KEY|INDEX)\s*(' + IDENT + r'\s*)?\(|INDEX\s+' + IDENT + r'\s+(UNIQUE|CLUSTERED|NONCLUSTERED|COLUMNSTORE|HASH)\b|CHECK\s*\(|PERIOD\s+FOR\b|EXCLUDE\s|LIKE\s', item, re.I):
            continue
        cmatch = re.match(r'(' + IDENT + r')\s*(.*)$', item, re.S)
        if not cmatch:
            continue
        cname = unquote(cmatch.group(1))
        tail = cmatch.group(2)
        tm = re.match(r'((?:[\w$.]+|"[^"]+")(?:\s*\([^)]*\))?(?:\s+(?:UNSIGNED|VARYING|PRECISION|WITH(?:OUT)?\s+TIME\s+ZONE|ZEROFILL))*(?:\s*\[\])?)', tail, re.I)
        typ = tm.group(1).strip() if tm else ''
        if re.match(r'(ENUM|SET)\s*\(', typ, re.I):
            typ = typ.split('(')[0].strip().upper()
        if typ.upper() in ('NOT', 'NULL', 'PRIMARY', 'DEFAULT', 'REFERENCES', 'CONSTRAINT', 'GENERATED', 'AS'):
            typ = ''
        tup = tail.upper()
        flags = ('N' if re.search(r'\bNOT\s+NULL\b', tup) else '') + ('U' if re.search(r'\bUNIQUE\b', tup) else '')
        if re.search(r'\bPRIMARY\s+KEY\b', tup):
            t['pk'] = [cname]
        rm = re.search(r'\bREFERENCES\s+((?:' + IDENT + r'\s*\.\s*)*' + IDENT + r')\s*(?:\(([^)]*)\))?', tail, re.I)
        if rm:
            m.fks.append((name, [cname], idents(rm.group(1))[-1], idents(rm.group(2)) if rm.group(2) else None, None))
        dm = re.search(r"\bCOMMENT\s+'((?:[^']|'')*)'", tail, re.I)
        t['columns'].append([cname, typ, flags, dm.group(1).replace("''", "'") if dm else None])
    m.approx.append(f'{where}: {name} read structurally (sqlglot could not)')
    return True


ALTER_ADD_RE = re.compile(r'ALTER\s+TABLE\s+(?:ONLY\s+|IF\s+EXISTS\s+)*((?:' + IDENT + r'\s*\.\s*)*' + IDENT + r')(.*)$', re.I | re.S)


def structural_alter(m, sql, where):
    s = strip_comments(sql)
    am = ALTER_ADD_RE.search(s)
    if not am:
        return False
    name = idents(am.group(1))[-1]
    rest = am.group(2)
    pm = re.search(r'ATTACH\s+PARTITION\s+((?:' + IDENT + r'\s*\.\s*)*' + IDENT + r')', rest, re.I)
    if pm:
        child = idents(pm.group(1))[-1]
        m.partitions.add(child.lower())
        m.parent[child.lower()] = name
        return True
    t = m.table(name, None, create=False)
    if t is None:
        return True
    for fm in re.finditer(r'FOREIGN\s+KEY\s*(?:' + IDENT + r'\s*)?\(([^)]*)\)\s*REFERENCES\s+((?:' + IDENT + r'\s*\.\s*)*' + IDENT + r')\s*(?:\(([^)]*)\))?', rest, re.I):
        m.fks.append((name, idents(fm.group(1)), idents(fm.group(2))[-1], idents(fm.group(3)) if fm.group(3) else None, None))
    for pk in re.finditer(r'PRIMARY\s+KEY\s*(?:CLUSTERED|NONCLUSTERED)?\s*\(([^)]*)\)', rest, re.I):
        t['pk'] = [c for c in idents(pk.group(1)) if c.upper() not in ('ASC', 'DESC')]
    for uq in re.finditer(r'\bUNIQUE\s*(?:KEY|INDEX|CLUSTERED|NONCLUSTERED)?\s*(?:' + IDENT + r'\s*)?\(([^)]*)\)', rest, re.I):
        m.uniques.append((name, [c for c in idents(uq.group(1)) if c.upper() not in ('ASC', 'DESC')], False))
    return True


EXTPROP_RE = re.compile(r"@name\s*=\s*N?'MS_Description'.*?@value\s*=\s*N?'((?:[^']|'')*)'.*?@level1name\s*=\s*N?'([^']*)'(?:.*?@level2type\s*=\s*N?'COLUMN'.*?@level2name\s*=\s*N?'([^']*)')?", re.I | re.S)


def count_sql(entry, base):
    dialect = entry['dialect']
    sg = SQLGLOT_DIALECT.get(dialect, 'postgres')
    m = Model()
    stats = {'statements': 0, 'sqlglot': 0, 'structural': 0, 'unread': 0}
    statements = []
    for f in sorted(entry['files'], key=lambda f: f['path']):
        if entry.get('pick') == 'folder' and not f['path'].lower().endswith('.sql'):
            continue
        with open(os.path.join(base, f['path']), encoding='utf-8', errors='replace') as fh:
            text = preprocess(fh.read(), dialect)
        for line, stmt in split_statements(text, dialect):
            statements.append((f, line, stmt))
    # In file order, as a database would run them; an ALTER TABLE for a table not created yet (a keys or
    # FK file that sorts before the tables file) waits until every file is read.
    deferred = []

    def handle(f, line, stmt, first):
        if True:
            body = strip_comments(stmt).strip()
            if not body:
                return
            up = body[:200].upper()
            where = f"{f['path']}:{line}"
            if re.match(r'EXEC(UTE)?\s+(SYS\.)?SP_ADDEXTENDEDPROPERTY', up):
                em = EXTPROP_RE.search(body)
                if em:
                    m.comments.append((em.group(2), em.group(3), em.group(1).replace("''", "'")))
                return
            kind = None
            if re.match(r'CREATE\s+(OR\s+REPLACE\s+)?((GLOBAL|LOCAL)\s+)?((UNLOGGED|EXTERNAL|TRANSIENT|MULTISET|SET)\s+)*(TEMP|TEMPORARY|VOLATILE)\s', up):
                return  # a temporary table (in a procedure body) is not part of the schema
            if re.match(r'CREATE\s+(OR\s+REPLACE\s+)?((GLOBAL|LOCAL)\s+)?((TEMP|TEMPORARY|UNLOGGED|EXTERNAL|TRANSIENT|VOLATILE|MULTISET|SET)\s+)*TABLE\b', up):
                kind = 'create'
            elif re.match(r'ALTER\s+TABLE\b', up):
                kind = 'alter'
            elif re.match(r'CREATE\s+UNIQUE\s+((CLUSTERED|NONCLUSTERED)\s+)?INDEX\b', up):
                kind = 'index'
            elif re.match(r'COMMENT\s+ON\s+(TABLE|COLUMN)\b', up):
                kind = 'comment'
            if re.match(r'DROP\s+TABLE\b', up):
                for name in re.findall(r'((?:' + IDENT + r'\s*\.\s*)*' + IDENT + r')', re.sub(r'^DROP\s+TABLE\s+(IF\s+EXISTS\s+)?', '', body, flags=re.I).split(' CASCADE')[0].split(' RESTRICT')[0]):
                    k = idents(name)[-1].lower() if idents(name) else ''
                    if k in m.tables:
                        del m.tables[k]
                        m.order.remove(k)
                        m.fks[:] = [fk for fk in m.fks if fk[0].lower() != k]
                return
            if not kind:
                return
            if kind == 'alter':
                am = ALTER_ADD_RE.search(body)
                target = idents(am.group(1))[-1] if am else ''
                if target.lower() not in m.tables:
                    if first:
                        deferred.append((f, line, stmt))  # a keys or FK file may sort before the tables file
                    return
                t = m.tables[target.lower()]
                rest = am.group(2)
                rn = re.match(r'\s*RENAME\s+TO\s+(' + IDENT + r')', rest, re.I)
                if rn:
                    new = unquote(rn.group(1))
                    i = m.order.index(target.lower())
                    del m.tables[target.lower()]
                    t['name'] = new
                    m.tables[new.lower()] = t
                    m.order[i] = new.lower()
                    m.fks[:] = [(new if fk[0].lower() == target.lower() else fk[0],) + fk[1:] for fk in m.fks]
                    # A comment made before the rename is on the renamed table (one made after names the new one).
                    m.comments[:] = [(new if c[0].lower() == target.lower() else c[0],) + tuple(c[1:]) for c in m.comments]
                    return
                drops = re.findall(r'DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(' + IDENT + r')', rest, re.I)
                drops = [unquote(d) for d in drops if unquote(d).upper() not in ('CONSTRAINT', 'INDEX', 'DEFAULT', 'NOT', 'PRIMARY', 'FOREIGN')]
                if drops and not re.search(r'\bADD\b', rest, re.I):
                    gone = {d.lower() for d in drops}
                    t['columns'] = [c for c in t['columns'] if c[0].lower() not in gone]
                    return
            stats['statements'] += 1
            parsed = None
            if sqlglot is not None:
                try:
                    parsed = sqlglot.parse_one(body, read=sg, error_level=sqlglot.ErrorLevel.RAISE)
                except Exception:
                    parsed = None
            ok = False
            if parsed is not None and not isinstance(parsed, exp.Command):
                snapshot = (list(m.order), {k: dict(v, columns=list(v['columns']), pk=list(v['pk'])) for k, v in m.tables.items()}, len(m.fks), len(m.uniques), set(m.partitions), dict(m.parent))
                try:
                    if kind == 'create' and isinstance(parsed, exp.Create) and (parsed.args.get('kind') or '').upper() == 'TABLE':
                        on_create_table(m, parsed, sg, where); ok = True
                    elif kind == 'alter' and isinstance(parsed, exp.Alter):
                        on_alter(m, parsed, sg, where); ok = True
                    elif kind == 'index' and isinstance(parsed, exp.Create):
                        on_index(m, parsed); ok = True
                    elif kind == 'comment' and isinstance(parsed, exp.Comment):
                        on_comment(m, parsed); ok = True
                except Exception as err:  # a shape this reader does not know
                    m.approx.append(f'{where}: sqlglot tree not read ({type(err).__name__})')
                    m.order, m.tables, m.partitions, m.parent = snapshot[0], snapshot[1], snapshot[4], snapshot[5]
                    del m.fks[snapshot[2]:]
                    del m.uniques[snapshot[3]:]
                    ok = False
            if ok:
                stats['sqlglot'] += 1
                return
            if kind == 'create' and structural_create(m, body, where):
                stats['structural'] += 1
            elif kind == 'alter' and structural_alter(m, body, where):
                stats['structural'] += 1
            elif kind == 'index' and re.search(r'\)\s*(?:INCLUDE\s*\([^)]*\)\s*)?(?:NULLS\s+(?:NOT\s+)?DISTINCT\s*)?(?:WITH\s*\([^)]*\)\s*)?WHERE\s', body, re.I):
                m.partial_uniques += 1
            elif kind == 'index':
                im = re.search(r'INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?' + IDENT + r'?\s*ON\s+(?:ONLY\s+)?((?:' + IDENT + r'\s*\.\s*)*' + IDENT + r')\s*(?:USING\s+\w+\s*)?\(', body, re.I)
                cols = index_columns(body, im.end() - 1) if im else None
                if im and cols:
                    m.uniques.append((idents(im.group(1))[-1], cols, True))
                    stats['structural'] += 1
                else:
                    stats['unread'] += 1
            elif kind == 'comment':
                cm = re.match(r"COMMENT\s+ON\s+(TABLE|COLUMN)\s+(.+?)\s+IS\s+'((?:[^']|'')*)'", body, re.I | re.S)
                if cm:
                    names = idents(cm.group(2))
                    if cm.group(1).upper() == 'TABLE':
                        m.comments.append((names[-1], None, cm.group(3).replace("''", "'")))
                    elif len(names) >= 2:
                        m.comments.append((names[-2], names[-1], cm.group(3).replace("''", "'")))
                    stats['structural'] += 1
                else:
                    stats['unread'] += 1
            else:
                stats['unread'] += 1
                m.approx.append(f'{where}: not read')

    for f, line, stmt in statements:
        handle(f, line, stmt, True)
    for f, line, stmt in list(deferred):
        handle(f, line, stmt, False)
    return finish_sql(entry, m, stats)


def finish_sql(entry, m, stats):
    for p in m.partitions:
        if p in m.tables:
            del m.tables[p]
            m.order.remove(p)
    for tname, col, text in m.comments:
        t = m.tables.get((tname or '').lower())
        if not t or text is None:
            continue
        if col is None:
            t['description'] = text
        else:
            for c in t['columns']:
                if c[0].lower() == col.lower():
                    c[3] = text
    tables = []
    for k in m.order:
        t = m.tables[k]
        pk = [c for c in t['pk'] if c]
        pkl = {c.lower() for c in pk}
        cols = []
        for name, typ, flags, desc in t['columns']:
            fl = ''.join(sorted(set(flags + ('P' if name.lower() in pkl else '') + ('N' if name.lower() in pkl else '')), key='PNUC'.index))
            col = [name, typ or '', fl]
            if desc:
                col.append(desc)
            cols.append(col)
        entry_t = {'name': t['name'], 'pk': pk, 'columns': cols}
        if t['schema']:
            entry_t['schema'] = t['schema']
        if t['description']:
            entry_t['description'] = t['description']
        tables.append(entry_t)
    rels = []
    seen = set()
    def folded(name):
        seen_p = set()
        while name.lower() in m.parent and name.lower() not in seen_p:
            seen_p.add(name.lower())
            name = m.parent[name.lower()]
        return name
    for i, (frm, fcols, to, tcols, cname) in enumerate(m.fks):
        frm, to = folded(frm), folded(to)
        if frm.lower() in m.partitions or to.lower() in m.partitions:
            continue
        if not tcols:
            target = m.tables.get(to.lower())
            tcols = target['pk'] if target else []
        if not tcols or len(tcols) != len(fcols):
            continue
        key = (frm.lower(), tuple(c.lower() for c in fcols), to.lower(), tuple(c.lower() for c in tcols))
        if key in seen:
            continue
        seen.add(key)
        comp = f'fk{i}' if len(fcols) > 1 else None
        for fc, tc in zip(fcols, tcols):
            r = {'from': frm, 'fromColumn': fc, 'to': to, 'toColumn': tc}
            if comp:
                r['composite'] = comp
            rels.append(r)
    uniques = []
    useen = set()
    for t, cols, idx in m.uniques:
        if t.lower() not in m.tables:
            continue
        key = (t.lower(), tuple(sorted(c.lower() for c in cols)))
        if key in useen:
            continue
        useen.add(key)
        u = {'table': t, 'columns': cols}
        if idx:
            u['index'] = True
        uniques.append(u)
    method = f"sqlglot {getattr(sqlglot, '__version__', '?')} ({SQLGLOT_DIALECT.get(entry['dialect'])}): {stats['sqlglot']} of {stats['statements']} DDL statements; {stats['structural']} read structurally; {stats['unread']} not read; {m.partial_uniques} partial unique indexes (WHERE) not counted as keys"
    return tables, rels, uniques, method, m.approx, sorted(m.partitions)


# ---------------------------------------------------------------------------
# dbt
# ---------------------------------------------------------------------------

def tests_of(node):
    out = []
    for key in ('tests', 'data_tests'):
        for t in node.get(key) or []:
            out.append(t)
    for c in (node.get('constraints') or []):
        if isinstance(c, dict):
            out.append({'__constraint__': c})
    return out


def test_name(t):
    if isinstance(t, str):
        return t, {}
    if isinstance(t, dict) and len(t) == 1:
        k, v = next(iter(t.items()))
        v = v if isinstance(v, dict) else {}
        args = v.get('arguments') if isinstance(v.get('arguments'), dict) else v
        return k, args
    return None, {}


def ref_name(s):
    if not isinstance(s, str):
        return None
    m = re.search(r"ref\(\s*['\"]([^'\"]+)['\"]\s*(?:,\s*['\"]([^'\"]+)['\"])?\s*\)", s)
    if m:
        return m.group(2) or m.group(1)
    m = re.search(r"source\(\s*['\"]([^'\"]+)['\"]\s*,\s*['\"]([^'\"]+)['\"]\s*\)", s)
    return m.group(2) if m else None


def count_dbt(entry, base):
    if yaml is None:
        raise RuntimeError('PyYAML is needed for dbt projects')
    models = {}
    order = []
    rels = []
    approx = []
    for f in sorted(entry['files'], key=lambda f: f['path']):
        if not re.match(r'models/.*\.ya?ml$', f['path']):
            continue
        try:
            with open(os.path.join(base, f['path']), encoding='utf-8') as fh:
                doc = yaml.safe_load(fh)
        except Exception as err:
            approx.append(f"{f['path']}: yml not read ({type(err).__name__})")
            continue
        if not isinstance(doc, dict):
            continue
        for mdl in doc.get('models') or []:
            if not isinstance(mdl, dict) or not mdl.get('name'):
                continue
            cfg = mdl.get('config') or {}
            if cfg.get('enabled') is False:
                continue
            cols = [c for c in (mdl.get('columns') or []) if isinstance(c, dict) and c.get('name')]
            if not cols:
                continue
            name = mdl['name']
            if name.lower() in models:
                continue
            pk = []
            out_cols = []
            for c in cols:
                tnames = set()
                for t in tests_of(c):
                    tn, args = test_name(t)
                    if tn is None and isinstance(t, dict) and '__constraint__' in t:
                        tn = (t['__constraint__'].get('type') or '')
                    if not tn:
                        continue
                    tnames.add(tn.split('.')[-1])
                    short = tn.split('.')[-1]
                    if short in ('relationships', 'relationships_where'):
                        to = ref_name(args.get('to'))
                        field = args.get('field')
                        if to and field:
                            r = {'from': name, 'fromColumn': c['name'], 'to': to, 'toColumn': field}
                            if short == 'relationships_where' or (isinstance(t, dict) and isinstance(next(iter(t.values())), dict) and (next(iter(t.values())).get('config') or {}).get('where')):
                                r['filtered'] = True
                            rels.append(r)
                flags = ''
                if 'not_null' in tnames or 'not_null' in {(x.get('type') if isinstance(x, dict) else '') for x in c.get('constraints') or []}:
                    flags += 'N'
                if 'unique' in tnames:
                    flags += 'U'
                if ('unique' in tnames and 'not_null' in tnames) or 'primary_key' in tnames:
                    pk.append(c['name'])
                desc = c.get('description')
                col = [c['name'], str(c.get('data_type') or ''), flags]
                if isinstance(desc, str) and desc.strip() and '{{' not in desc:
                    col.append(desc)
                out_cols.append(col)
            if len(pk) > 1:
                pk = []  # several single-column unique keys, not one composite key
            for col in out_cols:
                if col[0] in pk and 'P' not in col[2]:
                    col[2] = 'P' + col[2]
            t = {'name': name, 'pk': pk, 'columns': out_cols}
            d = mdl.get('description')
            if isinstance(d, str) and d.strip() and '{{' not in d:
                t['description'] = d
            models[name.lower()] = t
            order.append(name.lower())
    # A relationship to a model or source the yml does not describe is still one the source states.
    seen = set()
    out_rels = []
    for r in rels:
        k = (r['from'].lower(), r['fromColumn'].lower(), r['to'].lower(), r['toColumn'].lower())
        if k in seen:
            continue
        seen.add(k)
        out_rels.append(r)
    method = f'PyYAML {getattr(yaml, "__version__", "?")}: models/**.yml models with columns; key = a column tested unique and not_null; relationships(_where) tests'
    approx.append('descriptions using {{ doc() }} are left out of the truth (resolving them needs Jinja)')
    return [models[k] for k in order], out_rels, [], method, approx, []


# ---------------------------------------------------------------------------
# Power BI
# ---------------------------------------------------------------------------

def tmdl_name(s):
    s = s.strip()
    m = re.match(r"'((?:[^']|'')*)'", s)
    if m:
        return m.group(1).replace("''", "'"), s[m.end():]
    m = re.match(r'([^\s=:]+)', s)
    return (m.group(1), s[m.end():]) if m else (s, '')


def count_tmdl(entry, base):
    tables = []
    rels = []
    for f in sorted(entry['files'], key=lambda f: f['path']):
        p = f['path']
        if not p.endswith('.tmdl'):
            continue
        with open(os.path.join(base, p), encoding='utf-8-sig') as fh:
            lines = fh.read().replace('\r\n', '\n').split('\n')
        cur_t = None; cur_c = None; cur_r = None; in_partition = False
        for raw in lines:
            if not raw.strip() or raw.strip().startswith('///') or raw.strip().startswith('//'):
                continue
            indent = len(raw) - len(raw.lstrip('\t'))
            s = raw.strip()
            if indent == 0:
                cur_c = None; cur_r = None; in_partition = False
                if s.startswith('table '):
                    name, _ = tmdl_name(s[6:])
                    cur_t = {'name': name, 'pk': [], 'columns': []}
                    tables.append(cur_t)
                elif s.startswith('relationship '):
                    cur_t = None
                    cur_r = {}
                    rels.append(cur_r)
                else:
                    cur_t = None
                continue
            if cur_r is not None and indent == 1:
                m = re.match(r'(fromColumn|toColumn|isActive|crossFilteringBehavior|fromCardinality|toCardinality)\s*:\s*(.*)$', s)
                if m:
                    cur_r[m.group(1)] = m.group(2).strip()
                continue
            if cur_t is None:
                continue
            if indent == 1:
                cur_c = None; in_partition = False
                if s.startswith('column '):
                    name, rest = tmdl_name(s[7:])
                    cur_c = [name, '', 'C' if rest.strip().startswith('=') else '']
                    cur_t['columns'].append(cur_c)
                elif s.startswith('calculationGroup'):
                    cur_t['calculationGroup'] = True
                elif s.startswith('partition '):
                    in_partition = True
                    if re.search(r'=\s*calculated\b', s):
                        cur_t['calculatedTable'] = True
            elif indent == 2 and cur_c is not None:
                m = re.match(r'(dataType|isKey|description)\s*(?::\s*(.*))?$', s)
                if m and m.group(1) == 'dataType':
                    cur_c[1] = m.group(2).strip()
                elif m and m.group(1) == 'isKey':
                    if (m.group(2) or 'true').strip() != 'false':
                        cur_t['pk'] = [cur_c[0]]
                        cur_c[2] = 'P' + cur_c[2]
            elif indent == 2 and in_partition and re.match(r'mode\s*:', s):
                pass
    out_rels = []
    for r in rels:
        def split(ref):
            ref = ref.strip()
            m = re.match(r"('(?:[^']|'')*'|[^.]+)\.('(?:[^']|'')*'|.+)$", ref)
            if not m:
                return None, None
            return tmdl_name(m.group(1))[0], tmdl_name(m.group(2))[0]
        if 'fromColumn' not in r or 'toColumn' not in r:
            continue
        ft, fc = split(r['fromColumn']); tt, tc = split(r['toColumn'])
        if ft and tt:
            o = {'from': ft, 'fromColumn': fc, 'to': tt, 'toColumn': tc}
            if r.get('isActive') == 'false':
                o['inactive'] = True
            out_rels.append(o)
    return tables, out_rels, [], 'TMDL lines: table / column (= expression: calculated) / isKey / relationship fromColumn → toColumn; measures and hierarchies are not tables or columns', [], []


def count_bim(entry, base):
    tables = []; rels = []
    for f in entry['files']:
        if not f['path'].lower().endswith('.bim'):
            continue
        with open(os.path.join(base, f['path']), encoding='utf-8-sig') as fh:
            doc = json.load(fh)
        model = doc.get('model', doc)
        for t in model.get('tables') or []:
            cols = []
            pk = []
            for c in t.get('columns') or []:
                if c.get('type') == 'rowNumber':
                    continue
                flags = 'C' if c.get('type') in ('calculated', 'calculatedTableColumn') and t.get('partitions', [{}])[0].get('source', {}).get('type') != 'calculated' else ''
                if c.get('isKey'):
                    pk = [c['name']]; flags = 'P' + flags
                col = [c['name'], c.get('dataType', ''), flags]
                if c.get('description'):
                    col.append(c['description'] if isinstance(c['description'], str) else '\n'.join(c['description']))
                cols.append(col)
            o = {'name': t['name'], 'pk': pk, 'columns': cols}
            if t.get('calculationGroup'):
                o['calculationGroup'] = True
            if any((p.get('source') or {}).get('type') == 'calculated' for p in t.get('partitions') or []):
                o['calculatedTable'] = True
            tables.append(o)
        for r in model.get('relationships') or []:
            o = {'from': r['fromTable'], 'fromColumn': r['fromColumn'], 'to': r['toTable'], 'toColumn': r['toColumn']}
            if r.get('isActive') is False:
                o['inactive'] = True
            rels.append(o)
    return tables, rels, [], 'model.bim JSON: model.tables[].columns[] (rowNumber aside), isKey, relationships[]', [], []


# ---------------------------------------------------------------------------
# Rails schema.rb
# ---------------------------------------------------------------------------

def singular(s):
    if s.endswith('ies'):
        return s[:-3] + 'y'
    if s.endswith('ses') or s.endswith('xes'):
        return s[:-2]
    return s[:-1] if s.endswith('s') else s


def count_schema_rb(entry, base):
    tables = {}; order = []; rels = []; uniques = []
    for f in entry['files']:
        with open(os.path.join(base, f['path']), encoding='utf-8') as fh:
            text = fh.read()
        cur = None
        for line in text.split('\n'):
            m = re.match(r'\s*create_table\s+"([^"]+)"(.*)$', line)
            if m:
                name, opts = m.group(1), m.group(2)
                cur = {'name': name, 'pk': [], 'columns': []}
                tables[name] = cur; order.append(name)
                if 'id: false' not in opts:
                    pkm = re.search(r'primary_key:\s*(?:"([^"]+)"|\[([^\]]+)\])', opts)
                    if pkm and pkm.group(1):
                        cur['pk'] = [pkm.group(1)]
                    elif pkm:
                        cur['pk'] = re.findall(r'"([^"]+)"', pkm.group(2))
                    else:
                        cur['pk'] = ['id']
                    if len(cur['pk']) == 1 and cur['pk'][0] == 'id' or (pkm and pkm.group(1)):
                        tm = re.search(r'id:\s*:(\w+)', opts)
                        cur['columns'].append([cur['pk'][0], tm.group(1) if tm else 'bigint', 'PN'])
                continue
            if cur is not None:
                if re.match(r'\s*end\s*$', line):
                    cur = None
                    continue
                cm = re.match(r'\s*t\.(\w+)\s+"([^"]+)"(.*)$', line)
                if cm and cm.group(1) not in ('index', 'check_constraint', 'exclusion_constraint'):
                    if cm.group(1) == 'timestamps':
                        continue
                    flags = 'N' if 'null: false' in cm.group(3) else ''
                    if cm.group(2) in cur['pk']:
                        flags = 'PN'
                        cur['columns'] = [c for c in cur['columns'] if c[0] != cm.group(2)]
                    cur['columns'].append([cm.group(2), cm.group(1), flags])
                im = re.match(r'\s*t\.index\s+\[([^\]]*)\].*unique:\s*true', line)
                if im and 'where:' not in line:
                    uniques.append({'table': cur['name'], 'columns': re.findall(r'"([^"]+)"', im.group(1)), 'index': True})
                continue
            fm = re.match(r'\s*add_foreign_key\s+"([^"]+)",\s*"([^"]+)"(.*)$', line)
            if fm:
                frm, to, opts = fm.groups()
                col = re.search(r'column:\s*"([^"]+)"', opts)
                pkc = re.search(r'primary_key:\s*"([^"]+)"', opts)
                rels.append({'from': frm, 'fromColumn': col.group(1) if col else singular(to.split('.')[-1]) + '_id', 'to': to, 'toColumn': pkc.group(1) if pkc else 'id'})
    return [tables[k] for k in order], rels, uniques, 'regex over create_table / t.<type> / t.index unique / add_foreign_key (default column = singular(table)_id)', ['Rails conventions applied by regex: id primary keys, singularised FK columns'], []


# ---------------------------------------------------------------------------

def count(entry, base):
    imp = entry['importer']
    if imp == 'sql':
        return count_sql(entry, base)
    if imp == 'dbt':
        return count_dbt(entry, base)
    if imp == 'semanticModel':
        if any(f['path'].endswith('.tmdl') for f in entry['files']):
            return count_tmdl(entry, base)
        return count_bim(entry, base)
    if entry.get('kind', '').startswith('Rails schema.rb'):
        return count_schema_rb(entry, base)
    raise RuntimeError(f"no counter for {entry['name']}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', required=True)
    ap.add_argument('--only', default='')
    ap.add_argument('--manifest', default=os.path.join(HERE, 'manifest.json'))
    a = ap.parse_args()
    manifest = json.load(open(a.manifest, encoding='utf-8'))
    only = {s for s in a.only.split(',') if s}
    os.makedirs(os.path.join(a.cache, 'truth'), exist_ok=True)
    failed = 0
    for entry in manifest['schemas']:
        if only and entry['name'] not in only:
            continue
        base = os.path.join(a.cache, 'files', entry['name'])
        if not os.path.isdir(base):
            print(f"{entry['name']}: not fetched", file=sys.stderr)
            failed += 1
            continue
        try:
            tables, rels, uniques, method, approx, partitions = count(entry, base)
        except Exception as err:
            print(f"{entry['name']}: {type(err).__name__}: {err}", file=sys.stderr)
            failed += 1
            continue
        links = {(r['from'].lower() + ':' + r['composite']) if r.get('composite') else (r['from'] + '.' + r['fromColumn'] + '>' + r['to'] + '.' + r['toColumn']).lower() for r in rels}
        truth = {
            'importer': entry['importer'],
            'input': {},
            'counts': {
                'tables': len(tables),
                'columns': sum(len(t['columns']) for t in tables),
                'primaryKeys': sum(1 for t in tables if t['pk']),
                'relationships': len(links),
            },
            'tables': tables,
            'relationships': rels,
            'uniqueKeys': uniques,
            'method': method,
            'approximate': approx[:200],
            'approximateCount': len(approx),
            'partitionsFolded': len(partitions),
        }
        with open(os.path.join(a.cache, 'truth', entry['name'] + '.json'), 'w', encoding='utf-8') as fh:
            json.dump(truth, fh, indent=1, ensure_ascii=False)
        c = truth['counts']
        print(f"{entry['name']}: {c['tables']} tables, {c['columns']} columns, {c['primaryKeys']} keys, {c['relationships']} relationships ({len(approx)} approximate)")
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
