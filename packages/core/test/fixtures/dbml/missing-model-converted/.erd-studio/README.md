# .erd-studio

This folder is an ERD Studio data model, stored as DBML, an open format (https://dbml.dbdiagram.io).
Edit it in VS Code with ERD Studio, or with any text editor or AI assistant.

Every file lives under a layer folder. This project's layers, in order (layers.json lists them):

    1. Silver   silver/

In each layer folder:

    <layer>/tables/<schema>/<table>.dbml   one table: Table <schema>.<table> { … }
    <layer>/relationships/<file>.dbml      Refs between tables, split across files however you like
    <layer>/diagrams/<diagram>.dbml        one diagram: the tables it shows (use lines), the
                                           relationships files it needs, its sticky notes, and
                                           the table positions (erd_layout in its Project)

- A table is its schema and name: two schema folders may each hold a table of one name
  (tables/crm/customer.dbml, tables/erp/customer.dbml), but a schema holds a name once, across
  all layers.
- Each relationship is one Ref, stored once, in any relationships file.
- Other DBML tools read a diagram as a normal DBML project: open <layer>/diagrams/<name>.dbml.
- fields.yml (optional, beside layers.json) lists the fields each table and column records, in
  order; each is one setting, such as purpose: '…'. Without it, ERD Studio's starting set is used.

Check the files with `erd-studio doctor`.
