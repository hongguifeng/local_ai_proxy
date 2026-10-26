/**
 * The identity and version contract every routing write has to obey. It is kept separate
 * from the affinity table and the balancer because the same names are needed by the
 * request path, by failover, by a future migration service and by the management API: one
 * spelling for `runtimeEpoch`, `groupRevision`, `routingRevision` and binding incarnation,
 * and one state machine for a migration intent.
 *
 * Which entry point moves what (the TRI-01 map of the current writers):
 *
 * | entry point                                     | effect on identity and versions                       |
 * | ----------------------------------------------- | ----------------------------------------------------- |
 * | `bind` with no hit                              | new binding: incarnation allocated, routing revision 0 |
 * | `bind` with a hit and `allowRebind`             | target moves: routing revision +1                     |
 * | `rebind`                                        | target +1, only while the binding is still in the table |
 * | `plan` for a new task                           | calls `bind(..., { allowRebind: true })`               |
 * | the pipeline's one failover attempt             | releases, then plans with the old node excluded, which moves the target and bumps the revision |
 * | `attachResponseIds`                             | no target change; refused once the binding is gone      |
 * | `pruneTargets`, `clear`, `sweepExpired`, `remove` | bindings are removed; versions are never replayed      |
 * | `reconfigure`                                   | `groupRevision` +1 when a group's routing signature moved |
 * | `reloadPair`                                    | keeps `runtimeEpoch`; `groupRevision` follows the signature |
 * | `stopPair` and the next `startPair`             | bindings and reservations cleared; new `runtimeEpoch`   |
 * | `sweepNow`                                      | TTL eviction only; an evicted binding never comes back  |
 */

/** Routing revision of a binding that was just created and has never been moved. */
export const INITIAL_ROUTING_REVISION = 0;

/** First `groupRevision` a pair runtime hands out for a group it has never seen. */
export const INITIAL_GROUP_REVISION = 1;

/**
 * How a caller addresses one binding. The numeric `bindingId` is only unique inside the
 * affinity table of one runtime, so it is never carried alone: `runtimeEpoch` says which
 * runtime the binding lived in, `routingRevision` says which version of it the caller saw,
 * and `incarnation` — the field a management client does not send — is the write-side
 * guard that keeps a late reference off a binding that happened to reuse the number.
 */
export interface BindingRef {
  readonly runtimeEpoch: string;
  readonly groupId: string;
  readonly bindingId: number;
  readonly routingRevision: number;
  readonly incarnation: number;
}

/**
 * Lifecycle of one migration intent, from design section 5.2. `applied` means the in-memory
 * route changed; `observed` means a later request actually recorded the new target. Neither
 * says anything about the upstream's business result.
 */
export type MigrationState =
  | "requested"
  | "rejected"
  | "pending_boundary"
  | "applied"
  | "observed"
  | "cancelled"
  | "expired"
  | "expired_after_apply";

/**
 * The only moves the state machine allows. A terminal state has no outgoing edge, so an
 * already applied intent can never be rewritten as cancelled, and an expired one can never
 * be revived.
 */
export const MIGRATION_TRANSITIONS: Readonly<Record<MigrationState, readonly MigrationState[]>> = {
  requested: ["rejected", "pending_boundary", "applied"],
  rejected: [],
  pending_boundary: ["applied", "cancelled", "expired"],
  applied: ["observed", "expired_after_apply"],
  observed: [],
  cancelled: [],
  expired: [],
  expired_after_apply: [],
};

export function isMigrationTransitionAllowed(from: MigrationState, to: MigrationState): boolean {
  return MIGRATION_TRANSITIONS[from].includes(to);
}
