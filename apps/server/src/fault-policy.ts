export type FaultPolicy = Readonly<{
  outcome: string;
  health: "ok" | "degraded" | "failed";
  logCode: string;
  recovery: string;
}>;

export const FAULT_POLICIES = Object.freeze({
  sqliteLocked: {
    outcome: "write_retried_or_dropped",
    health: "degraded",
    logCode: "SQLITE_BUSY",
    recovery: "bounded retry; resume after lock release",
  },
  workerCrash: {
    outcome: "storage_temporarily_unavailable",
    health: "degraded",
    logCode: "STORAGE_RESTARTING",
    recovery: "finite exponential restart",
  },
  diskUnavailable: {
    outcome: "persistence_disabled",
    health: "degraded",
    logCode: "DISK_LOW_WATERMARK",
    recovery: "cleanup or restore writable capacity",
  },
  configRenameFailed: {
    outcome: "original_config_preserved",
    health: "ok",
    logCode: "CONFIG_WRITE_FAILED",
    recovery: "retry atomic replacement",
  },
  upstreamFailure: {
    outcome: "safe_502_or_504",
    health: "ok",
    logCode: "UPSTREAM_FAILED",
    recovery: "next request may retry",
  },
  shutdownConnections: {
    outcome: "new_connections_rejected",
    health: "degraded",
    logCode: "SERVER_SHUTDOWN",
    recovery: "restart service",
  },
  logQueueOverload: {
    outcome: "bounded_drop",
    health: "degraded",
    logCode: "STORAGE_QUEUE_FULL",
    recovery: "drain queue and resume",
  },
} satisfies Record<string, FaultPolicy>);
