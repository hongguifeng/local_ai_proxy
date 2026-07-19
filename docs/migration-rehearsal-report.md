# Node Migration Rehearsal Report

## Configuration fixture

The comprehensive Python configuration fixture is copied to an isolated directory, loaded and
normalized by Node, backed up before its first save, changed, loaded again, and finally restored from
the timestamped `before-node` backup. The restored configuration matches the original normalized
fixture exactly. This rehearsal is automated in the Node config repository test suite.

## Small database

A schema-v1 database is created in an isolated directory and copied as the rollback snapshot. Opening
it through `TrafficRepository` applies the current migration, after which a task is written and queried.
The original v1 snapshot is then restored; reopening migrates it cleanly again and confirms the test
write is absent.

## Active WAL database

The backup test keeps the source database connection open, verifies that a WAL file exists after a
write, performs a passive checkpoint, and uses SQLite's backup API to create a separate database. The
backup is opened read-only and contains both the WAL-backed row and the current schema version.

## Large database capacity benchmark

On 2026-07-18, the repeatable benchmark generated 1,000 records, each with request and response JSON
containing roughly 2 KiB of repeated text. The resulting SQLite database was 11,558,912 bytes; its
online backup was the same size and completed in 790.45 ms in the local WSL2 workspace. The calculated
minimum free space (source + backup + 20% headroom) was 27,741,389 bytes. Real migration instructions
therefore require at least 2.4 times the current `traffic.db` size to cover the backup and headroom.

The benchmark is available as `npm run benchmark:migration -- <record-count>`. A 5,000-record attempt
was intentionally stopped after several minutes because fixture generation uses the normal durable
per-record write path; operators should run larger counts against their target disk when planning a
specific deployment window.

## Relationship and content validation

The comprehensive fixture contains 5 tasks, 6 records, 2 response links, 2 context links, and 6 search
documents. Validation found zero orphan records, links, or search documents. Sampled content included
`task-chat-fixture` with model `chat-fixture` and `record-chat-1` with HTTP status 200. The reusable
command is `npm run validate:migration -- <log-root>` after `npm run build`.

The operator-facing backup and rollback sequence is maintained in `docs/migration-rollback.md`.

## Real production-data copy rehearsal

On 2026-07-18, `npm run rehearse:real-data -- <source-log-root> <empty-rehearsal-root>` was run
with Windows Node.js against an active 7,584,448,512-byte production database on the Windows host.
The SQLite online backup completed in 48.40 seconds without stopping or modifying the source. All
work after that point used an isolated directory on the same data drive.

The copied configuration loaded, saved, and restored successfully with one proxy pair. The migrated
database contained 73 tasks, 4,199 records, 5 response links, 23 context links, and 3,924 search
documents. Validation found zero orphan records, response links, context links, or search documents.
The rollback copy matched the online-backup SHA-256 exactly, and reopening it through the Node
repository reproduced the same counts and zero-orphan result.
