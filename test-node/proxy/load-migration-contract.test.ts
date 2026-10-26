import { describe, expect, it } from "vitest";

import {
  INITIAL_GROUP_REVISION,
  INITIAL_ROUTING_REVISION,
  MIGRATION_TRANSITIONS,
  isMigrationTransitionAllowed,
  type MigrationState,
} from "../../src/proxy/index.js";

const DOCUMENTED_STATES: readonly MigrationState[] = [
  "requested",
  "rejected",
  "pending_boundary",
  "applied",
  "observed",
  "cancelled",
  "expired",
  "expired_after_apply",
];

const TERMINAL_STATES: readonly MigrationState[] = [
  "rejected",
  "observed",
  "cancelled",
  "expired",
  "expired_after_apply",
];

describe("load migration contract", () => {
  it("TRI-01 fixes the first value of every version counter", () => {
    // A binding that has never been moved is at revision 0, and the first revision a pair
    // runtime hands out for a group it has never seen is 1.
    expect(INITIAL_ROUTING_REVISION).toBe(0);
    expect(INITIAL_GROUP_REVISION).toBe(1);
  });

  it("TRI-01 lists exactly the states the migration state machine names", () => {
    expect(Object.keys(MIGRATION_TRANSITIONS).sort()).toStrictEqual([...DOCUMENTED_STATES].sort());
  });

  it("TRI-01 a requested intent is only rejected, applied or parked at a boundary", () => {
    expect(MIGRATION_TRANSITIONS.requested).toStrictEqual([
      "rejected",
      "pending_boundary",
      "applied",
    ]);
    // Nothing that has not happened yet can be claimed as an outcome of a request.
    for (const state of ["observed", "cancelled", "expired", "expired_after_apply"] as const) {
      expect(isMigrationTransitionAllowed("requested", state)).toBe(false);
    }
  });

  it("TRI-01 a parked intent ends by applying, by being cancelled or by expiring", () => {
    expect(MIGRATION_TRANSITIONS.pending_boundary).toStrictEqual([
      "applied",
      "cancelled",
      "expired",
    ]);
    expect(isMigrationTransitionAllowed("pending_boundary", "observed")).toBe(false);
    expect(isMigrationTransitionAllowed("pending_boundary", "rejected")).toBe(false);
  });

  it("TRI-01 applied is not observed, and applied is never cancelled", () => {
    expect(MIGRATION_TRANSITIONS.applied).toStrictEqual(["observed", "expired_after_apply"]);
    expect(isMigrationTransitionAllowed("applied", "cancelled")).toBe(false);
    expect(isMigrationTransitionAllowed("applied", "pending_boundary")).toBe(false);
    // A later request has to confirm the new target before the move counts as observed.
    expect(isMigrationTransitionAllowed("observed", "expired_after_apply")).toBe(false);
  });

  it("TRI-01 a terminal state has no way back into the machine", () => {
    for (const state of TERMINAL_STATES) {
      expect(MIGRATION_TRANSITIONS[state]).toStrictEqual([]);
      for (const next of DOCUMENTED_STATES) {
        expect(isMigrationTransitionAllowed(state, next)).toBe(false);
      }
    }
  });
});
