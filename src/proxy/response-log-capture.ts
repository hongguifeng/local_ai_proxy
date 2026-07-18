import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { bytesPayload, type BytePayload } from "./payload.js";
import { IncrementalSseAccumulator } from "./streams.js";

export const DEFAULT_RESPONSE_LOG_MEMORY_THRESHOLD_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_RESPONSE_LOG_BODY_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_SSE_SUMMARY_INPUT_BYTES = 8 * 1024 * 1024;

export interface ResponseLogCaptureOptions {
  readonly maxBytes?: number;
  readonly maxSseSummaryInputBytes?: number;
  readonly memoryThresholdBytes?: number;
  readonly spoolDirectory?: string;
}

export interface TruncatedResponseLogPayload {
  readonly captured_bytes: number;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly stream_summary?: Readonly<Record<string, unknown>>;
  readonly text: string;
  readonly truncated: true;
  readonly truncation_reason: "log_body_limit";
}

export type ResponseLogPayload = BytePayload | TruncatedResponseLogPayload;

export class ResponseLogCapture {
  readonly #chunks: Buffer[] = [];
  readonly #hash = createHash("sha256");
  readonly #maxBytes: number;
  readonly #maxSseSummaryInputBytes: number;
  readonly #memoryThresholdBytes: number;
  readonly #spoolDirectory: string;
  readonly #sseAccumulator: IncrementalSseAccumulator | undefined;
  #capturedBytes = 0;
  #file: FileHandle | undefined;
  #finalized = false;
  #sizeBytes = 0;
  #spoolPath: string | undefined;
  #spoolQueue: Promise<void> = Promise.resolve();
  #sseSummaryInputBytes = 0;
  #sseSummaryTruncated = false;

  constructor(sse: boolean, options?: ResponseLogCaptureOptions) {
    this.#memoryThresholdBytes =
      options?.memoryThresholdBytes ?? DEFAULT_RESPONSE_LOG_MEMORY_THRESHOLD_BYTES;
    this.#maxBytes = options?.maxBytes ?? DEFAULT_MAX_RESPONSE_LOG_BODY_BYTES;
    this.#maxSseSummaryInputBytes =
      options?.maxSseSummaryInputBytes ?? DEFAULT_MAX_SSE_SUMMARY_INPUT_BYTES;
    this.#spoolDirectory = options?.spoolDirectory ?? path.join(os.tmpdir(), "llm-proxy-spool");
    if (
      this.#memoryThresholdBytes < 0 ||
      this.#maxBytes < 1 ||
      this.#memoryThresholdBytes > this.#maxBytes ||
      this.#maxSseSummaryInputBytes < 1
    ) {
      throw new RangeError(
        "Response capture limits require 0 <= memory threshold <= max bytes and a positive SSE summary limit.",
      );
    }
    this.#sseAccumulator = sse ? new IncrementalSseAccumulator() : undefined;
  }

  addChunk(chunk: Uint8Array): void {
    if (this.#finalized) {
      throw new Error("Cannot capture a response chunk after finalize().");
    }
    const copy = Buffer.from(chunk);
    this.#sizeBytes += copy.byteLength;
    this.#hash.update(copy);
    this.#captureSseSummary(copy);

    const remaining = this.#maxBytes - this.#capturedBytes;
    if (remaining <= 0) {
      return;
    }
    const captured = copy.byteLength <= remaining ? copy : Buffer.from(copy.subarray(0, remaining));
    this.#capturedBytes += captured.byteLength;
    if (this.#spoolPath === undefined && this.#capturedBytes > this.#memoryThresholdBytes) {
      this.#startSpooling();
    }
    if (this.#spoolPath === undefined) {
      this.#chunks.push(captured);
    } else {
      this.#enqueueWrite(captured);
    }
  }

  async finalize(): Promise<ResponseLogPayload> {
    if (this.#finalized) {
      throw new Error("Response log capture has already been finalized.");
    }
    this.#finalized = true;
    const sha256 = this.#hash.digest("hex");
    const streamSummary = this.#finalizeSseSummary();
    let captured: Buffer;
    try {
      await this.#spoolQueue;
      await this.#file?.close();
      this.#file = undefined;
      captured =
        this.#spoolPath === undefined
          ? Buffer.concat(this.#chunks, this.#capturedBytes)
          : await readFile(this.#spoolPath);
    } finally {
      await this.#file?.close().catch(() => undefined);
      if (this.#spoolPath !== undefined) {
        await rm(this.#spoolPath, { force: true });
      }
    }
    if (this.#sizeBytes <= this.#maxBytes) {
      const payload = bytesPayload(captured);
      return streamSummary === undefined ? payload : { ...payload, stream_summary: streamSummary };
    }
    return {
      text: captured.toString("utf8"),
      size_bytes: this.#sizeBytes,
      captured_bytes: captured.byteLength,
      sha256,
      truncated: true,
      truncation_reason: "log_body_limit",
      ...(streamSummary === undefined ? {} : { stream_summary: streamSummary }),
    };
  }

  #captureSseSummary(chunk: Buffer): void {
    if (this.#sseAccumulator === undefined) {
      return;
    }
    if (this.#sseSummaryInputBytes + chunk.byteLength > this.#maxSseSummaryInputBytes) {
      this.#sseSummaryTruncated = true;
      return;
    }
    this.#sseSummaryInputBytes += chunk.byteLength;
    this.#sseAccumulator.addChunk(chunk);
  }

  #finalizeSseSummary(): Readonly<Record<string, unknown>> | undefined {
    const summary = this.#sseAccumulator?.finalize()?.stream_summary;
    if (summary === undefined) {
      return this.#sseSummaryTruncated
        ? {
            summary_truncated: true,
            summary_input_bytes: this.#sseSummaryInputBytes,
            summary_limit_bytes: this.#maxSseSummaryInputBytes,
          }
        : undefined;
    }
    return this.#sseSummaryTruncated
      ? {
          ...summary,
          summary_truncated: true,
          summary_input_bytes: this.#sseSummaryInputBytes,
          summary_limit_bytes: this.#maxSseSummaryInputBytes,
        }
      : summary;
  }

  #startSpooling(): void {
    this.#spoolPath = path.join(this.#spoolDirectory, `response-${randomUUID()}.tmp`);
    const buffered = this.#chunks.splice(0);
    for (const chunk of buffered) {
      this.#enqueueWrite(chunk);
    }
  }

  #enqueueWrite(chunk: Buffer): void {
    const spoolPath = this.#spoolPath;
    if (spoolPath === undefined) {
      throw new Error("Response spool path was not initialized.");
    }
    this.#spoolQueue = this.#spoolQueue.then(async () => {
      if (this.#file === undefined) {
        await mkdir(this.#spoolDirectory, { mode: 0o700, recursive: true });
        this.#file = await open(spoolPath, "wx", 0o600);
      }
      await this.#file.write(chunk);
    });
  }
}
