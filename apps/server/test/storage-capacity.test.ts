import { describe, expect, it, vi } from "vitest";
import {
  CAPTURE_LIMITS,
  DEFAULT_STORAGE_QUEUE_BYTES,
  MAX_STORAGE_QUEUE_BYTES,
  RetentionJob,
} from "../src/storage/capacity.js";

describe("storage capacity and retention", () => {
  it("publishes bounded capture and queue defaults", () => {
    expect(CAPTURE_LIMITS.requestBytes).toBeLessThanOrEqual(CAPTURE_LIMITS.hardCaptureBytes);
    expect(CAPTURE_LIMITS.responseBytes).toBeLessThanOrEqual(CAPTURE_LIMITS.hardCaptureBytes);
    expect(DEFAULT_STORAGE_QUEUE_BYTES).toBeLessThan(MAX_STORAGE_QUEUE_BYTES);
  });
  it("runs bounded cleanup only while idle and reports low disk degradation", async () => {
    const cleanup = vi.fn(() => Promise.resolve(undefined));
    const state = vi.fn();
    let idle = false;
    const job = new RetentionJob({
      source: { cleanup },
      dataPath: ".",
      days: 30,
      maxTasks: 10_000,
      lowWatermarkBytes: 1_000,
      isIdle: () => idle,
      freeBytes: () => Promise.resolve(500),
      onStorageState: state,
    });
    await expect(job.run()).resolves.toBe("busy");
    idle = true;
    await expect(job.run()).resolves.toBe("low_disk");
    expect(cleanup).toHaveBeenCalledWith({ olderThanDays: 30, keepLatest: 10_000, batchSize: 100 });
    expect(state).toHaveBeenCalledWith("degraded", "DISK_LOW_WATERMARK");
  });
});
