import { Transform, type TransformCallback } from "node:stream";

export interface StreamObserver {
  push(chunk: Uint8Array): void | Promise<void>;
  finish?(): unknown;
  summary?(): unknown;
}

export type CaptureTapResult = Readonly<{
  captured: Uint8Array;
  observedBytes: number;
  capturedBytes: number;
  truncated: boolean;
  summary: unknown;
  diagnostics: readonly string[];
}>;

export class CaptureTap extends Transform {
  readonly #maxCaptureBytes: number;
  readonly #chunks: Buffer[] = [];
  readonly #diagnostics: string[] = [];
  #observer: StreamObserver | null;
  #observedBytes = 0;
  #capturedBytes = 0;
  #summary: unknown;

  public constructor(maxCaptureBytes: number, observer: StreamObserver | null = null) {
    super();
    if (!Number.isSafeInteger(maxCaptureBytes) || maxCaptureBytes < 0) {
      throw new RangeError("maxCaptureBytes must be a non-negative safe integer");
    }
    this.#maxCaptureBytes = maxCaptureBytes;
    this.#observer = observer;
  }

  public override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#observedBytes += chunk.byteLength;
    const remaining = this.#maxCaptureBytes - this.#capturedBytes;
    if (remaining > 0) {
      const captured = Buffer.from(chunk.subarray(0, Math.min(remaining, chunk.byteLength)));
      this.#chunks.push(captured);
      this.#capturedBytes += captured.byteLength;
    }
    this.#observe(chunk);
    callback(null, chunk);
  }

  public override _flush(callback: TransformCallback): void {
    const observer = this.#observer;
    if (observer?.finish) {
      try {
        const result = observer.finish();
        if (isPromise(result)) {
          void result.then(
            (summary) => {
              this.#summary = summary;
            },
            () => {
              this.#disableObserver("summarizer_finish_failed");
            },
          );
        } else {
          this.#summary = result;
        }
      } catch {
        this.#disableObserver("summarizer_finish_failed");
      }
    } else if (observer?.summary) {
      try {
        this.#summary = observer.summary();
      } catch {
        this.#disableObserver("summarizer_summary_failed");
      }
    }
    callback();
  }

  public result(): CaptureTapResult {
    return {
      captured: Buffer.concat(this.#chunks, this.#capturedBytes),
      observedBytes: this.#observedBytes,
      capturedBytes: this.#capturedBytes,
      truncated: this.#observedBytes > this.#capturedBytes,
      summary: this.#summary,
      diagnostics: [...this.#diagnostics],
    };
  }

  #observe(chunk: Uint8Array): void {
    const observer = this.#observer;
    if (!observer) return;
    try {
      const pending = observer.push(chunk);
      if (isPromise(pending)) {
        void pending.catch(() => {
          this.#disableObserver("summarizer_push_failed");
        });
      }
    } catch {
      this.#disableObserver("summarizer_push_failed");
    }
  }

  #disableObserver(code: string): void {
    this.#observer = null;
    if (!this.#diagnostics.includes(code)) this.#diagnostics.push(code);
  }
}

function isPromise(value: unknown): value is Promise<unknown> {
  return value !== null && typeof value === "object" && "then" in value && typeof value.then === "function";
}
