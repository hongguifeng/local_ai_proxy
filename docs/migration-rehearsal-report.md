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
