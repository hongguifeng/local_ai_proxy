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
