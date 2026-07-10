# Storage schema migrations

Node schema v1 is deliberately compatible with the Python v1 traffic database: table names, columns, indexes,
foreign keys, and FTS layout are unchanged. Existing Python v1 databases therefore open without a data rewrite;
Node only adds `schema_migrated_at` metadata when it first owns the database.

New migrations use zero-padded, monotonically increasing filenames. A migration and its schema version metadata
update run in one SQLite transaction. Released migration files are immutable.
