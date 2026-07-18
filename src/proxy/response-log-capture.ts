import { bytesPayload, type BytePayload } from "./payload.js";
import { IncrementalSseAccumulator } from "./streams.js";

export interface ResponseLogPayload extends BytePayload {
  readonly stream_summary?: Readonly<Record<string, unknown>>;
}

export class ResponseLogCapture {
  readonly #chunks: Buffer[] = [];
  readonly #sseAccumulator: IncrementalSseAccumulator | undefined;
  #sizeBytes = 0;
  #finalized = false;

  constructor(sse: boolean) {
    this.#sseAccumulator = sse ? new IncrementalSseAccumulator() : undefined;
  }

  addChunk(chunk: Uint8Array): void {
    if (this.#finalized) {
      throw new Error("Cannot capture a response chunk after finalize().");
    }
    const copy = Buffer.from(chunk);
    this.#chunks.push(copy);
    this.#sizeBytes += copy.byteLength;
    this.#sseAccumulator?.addChunk(copy);
  }

  finalize(): ResponseLogPayload {
    if (this.#finalized) {
      throw new Error("Response log capture has already been finalized.");
    }
    this.#finalized = true;
    const payload = bytesPayload(Buffer.concat(this.#chunks, this.#sizeBytes));
    const summary = this.#sseAccumulator?.finalize();
    return summary === undefined ? payload : { ...payload, ...summary };
  }
}
