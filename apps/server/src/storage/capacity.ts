import { statfs } from "node:fs/promises";

import {
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  DEFAULT_REQUEST_CAPTURE_BYTES,
  DEFAULT_RESPONSE_CAPTURE_BYTES,
  MAX_CAPTURE_BYTES,
} from "@llm-proxy/contracts";

export const DEFAULT_STORAGE_QUEUE_COUNT = 2_000;
export const MAX_STORAGE_QUEUE_COUNT = 100_000;
export const DEFAULT_STORAGE_QUEUE_BYTES = 128 * 1024 * 1024;
export const MAX_STORAGE_QUEUE_BYTES = 1024 * 1024 * 1024;
export const CAPTURE_LIMITS = Object.freeze({
  maxRequestBodyBytes: DEFAULT_MAX_REQUEST_BODY_BYTES,
  requestBytes: DEFAULT_REQUEST_CAPTURE_BYTES,
  responseBytes: DEFAULT_RESPONSE_CAPTURE_BYTES,
  hardCaptureBytes: MAX_CAPTURE_BYTES,
});

export interface RetentionSource {
  cleanup(options: { olderThanDays: number; keepLatest: number; batchSize: number }): Promise<unknown>;
}
export interface RetentionJobOptions {
  source: RetentionSource;
  dataPath: string;
  days: number;
  maxTasks: number;
  lowWatermarkBytes: number;
  isIdle: () => boolean;
  onStorageState?: (state: "ok" | "degraded", code?: string) => void;
  freeBytes?: (path: string) => Promise<number>;
}

export class RetentionJob {
  readonly #options: RetentionJobOptions;
  #running = false;
  public constructor(options: RetentionJobOptions) {
    if (!Number.isInteger(options.days) || options.days < 0 || options.days > 3_650)
      throw new RangeError("Invalid retention days");
    if (!Number.isInteger(options.maxTasks) || options.maxTasks < 0) throw new RangeError("Invalid retention capacity");
    if (!Number.isSafeInteger(options.lowWatermarkBytes) || options.lowWatermarkBytes < 0)
      throw new RangeError("Invalid disk watermark");
    this.#options = options;
  }
  public async run(): Promise<"completed" | "busy" | "low_disk"> {
    if (this.#running || !this.#options.isIdle()) return "busy";
    this.#running = true;
    try {
      const free = await (this.#options.freeBytes ?? availableBytes)(this.#options.dataPath);
      const low = free < this.#options.lowWatermarkBytes;
      if (low) this.#options.onStorageState?.("degraded", "DISK_LOW_WATERMARK");
      await this.#options.source.cleanup({
        olderThanDays: this.#options.days,
        keepLatest: this.#options.maxTasks,
        batchSize: 100,
      });
      if (!low) this.#options.onStorageState?.("ok");
      return low ? "low_disk" : "completed";
    } finally {
      this.#running = false;
    }
  }
}
async function availableBytes(path: string): Promise<number> {
  const result = await statfs(path);
  return result.bavail * result.bsize;
}
