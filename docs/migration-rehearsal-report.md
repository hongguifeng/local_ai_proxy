# Node Migration Rehearsal Report

## Configuration fixture

The comprehensive Python configuration fixture is copied to an isolated directory, loaded and
normalized by Node, backed up before its first save, changed, loaded again, and finally restored from
the timestamped `before-node` backup. The restored configuration matches the original normalized
fixture exactly. This rehearsal is automated in the Node config repository test suite.
