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
 * | `bind` with a hit and `allowRebind`             | hands the move to `rebind`: target moves, revision +1   |
 * | `rebind`                                        | the single write: target +1 revision, only while the binding is still in the table |
 * | `moveBinding()`                                 | the single safe entry: re-checks every version and target, then writes through `rebind` |
 * | `cancelMoveBinding()`                           | calls off an intent that has not been applied; never rewrites a write |
 * | a reservation release (the request boundary)    | applies a parked intent whose binding is back at zero in flight |
 * | `plan` for a new task                           | calls `bind(..., { allowRebind: true })`               |
 * | the pipeline's one failover attempt             | releases, then plans with the old node excluded, which moves the target and bumps the revision |
 * | `invalidateMigrationsFor` at that failover      | parks become `expired`, an applied intent becomes `expired_after_apply` |
 * | `confirmRouted()` once the upstream answered    | the applied intent the destination proves becomes `observed`, terminal  |
 * | `attachResponseIds`                             | no target change; refused once the binding is gone      |
 * | `pruneTargets`, `clear`, `sweepExpired`, `remove` | bindings are removed; versions are never replayed      |
 * | `reconfigure`                                   | `groupRevision` +1 when a group's routing signature moved; waiting intents are re-checked |
 * | `reloadPair`                                    | keeps `runtimeEpoch`; `groupRevision` follows the signature |
 * | `stopPair` and the next `startPair`             | bindings, reservations and migration records cleared; new `runtimeEpoch` |
 * | `sweepNow`                                      | TTL eviction, ledger cleanup, and expiry of intents that drifted or aged out |
 */

/** Routing revision of a binding that was just created and has never been moved. */
export const INITIAL_ROUTING_REVISION = 0;

/** First `groupRevision` a pair runtime hands out for a group it has never seen. */
export const INITIAL_GROUP_REVISION = 1;

/**
 * How a caller addresses one binding. The numeric `bindingId` is only unique inside the
 * affinity table of one runtime, so it is never carried alone: `runtimeEpoch` says which
 * runtime the binding lived in, `routingRevision` says which version of it the caller saw,
 * and `incarnation` — which the management API carries as the binding list gives it out, since
 * design section 6.1 puts it on the row for exactly this reason — is the write-side
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
 * route changed; `observed` means a later request proved the destination received it - the
 * request path confirms it once the upstream answered the connection, not when the request was
 * planned. Neither says anything about the upstream's business result.
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
