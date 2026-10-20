import type { Transform } from "node:stream";
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
  createInflateRaw,
  createZstdDecompress,
} from "node:zlib";

/**
 * Upstream servers compress responses: the proxy forwards the client's
 * `accept-encoding` untouched, so the bytes coming back are gzip, brotli, zstd
 * or deflate. Those encoded bytes are exactly what the client expects, so they
 * are streamed to it unchanged. The traffic log, on the other hand, must record
 * the body the model actually produced - the SSE events, the usage object and
 * the timing of the first token are only readable once the payload is decoded.
 *
 * This decoder sits beside the client copy: it receives the same encoded chunks
 * and hands the decoded ones to the log capture. Encodings the runtime cannot
 * decode are logged as-is instead of failing the request.
 */
export type ResponseBodySink = (chunk: Buffer) => void;

export interface ResponseBodyDecoder {
  /** Feed one encoded chunk of the upstream body. Never throws. */
  push(chunk: Buffer): void;
  /** Mark the end of the body and wait until the sink saw everything it can decode. */
  finish(): Promise<void>;
}

function parseContentEncoding(headerValue: string | string[] | undefined): string[] {
  const joined = Array.isArray(headerValue) ? headerValue.join(",") : (headerValue ?? "");
  const applied = joined
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== "" && token !== "identity");
  // The header lists the encodings in the order they were applied, so undoing
  // them runs the list backwards.
  return applied.reverse();
}

/**
 * A zlib (RFC 1950) framed stream starts with a two byte header whose check
 * bits make the pair a multiple of 31. Raw deflate (RFC 1951) has no such
 * header, and both show up in the wild under the `deflate` content encoding.
 */
function isZlibFramed(head: Buffer | undefined): boolean {
  const first = head?.[0];
  const second = head?.[1];
  if (first === undefined || second === undefined) {
    return false;
  }
  return (first & 0x0f) === 8 && (second & 0x20) === 0 && ((first << 8) | second) % 31 === 0;
}

function createDecodeStage(encoding: string, head: Buffer | undefined): Transform | undefined {
  try {
    switch (encoding) {
      case "br":
        return createBrotliDecompress();
      case "deflate":
      case "x-deflate":
        return isZlibFramed(head) ? createInflate() : createInflateRaw();
      case "gzip":
      case "x-gzip":
        return createGunzip();
      case "zstd":
        return createZstdDecompress();
      default:
        return undefined;
    }
  } catch {
    // A runtime without this codec (an older Node without zstd, for example)
    // cannot decode the body, and the log falls back to the encoded bytes.
    return undefined;
  }
}

class EncodedResponseBodyDecoder implements ResponseBodyDecoder {
  readonly #sink: ResponseBodySink;
  readonly #encodings: readonly string[];
  readonly #finishPromise: Promise<void>;
  readonly #settle: () => void;
  #stages: Transform[] = [];
  #first: Transform | undefined;
  #passthrough: boolean;
  #failed = false;
  #ended = false;

  constructor(encodings: readonly string[], sink: ResponseBodySink) {
    this.#encodings = encodings;
    this.#sink = sink;
    this.#passthrough = encodings.length === 0;
    let settle: () => void = () => undefined;
    this.#finishPromise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.#settle = settle;
  }

  push(chunk: Buffer): void {
    if (this.#failed || this.#ended) {
      return;
    }
    if (this.#passthrough) {
      this.#deliver(chunk);
      return;
    }
    const first = this.#first ?? this.#buildStages(chunk);
    if (first === undefined) {
      this.#deliver(chunk);
      return;
    }
    first.write(chunk);
  }

  async finish(): Promise<void> {
    if (this.#ended) {
      return this.#finishPromise;
    }
    this.#ended = true;
    const first = this.#first;
    if (first === undefined || this.#failed) {
      this.#settle();
    } else {
      // Flushing a truncated compressed stream raises an error, which settles
      // the promise through the stage listeners instead.
      first.end();
    }
    return this.#finishPromise;
  }

  #buildStages(head: Buffer): Transform | undefined {
    const stages: Transform[] = [];
    for (const [index, encoding] of this.#encodings.entries()) {
      const stage = createDecodeStage(encoding, index === 0 ? head : undefined);
      if (stage === undefined) {
        this.#passthrough = true;
        return undefined;
      }
      stages.push(stage);
    }
    const last = stages.at(-1);
    const first = stages.at(0);
    if (last === undefined || first === undefined) {
      this.#passthrough = true;
      return undefined;
    }
    for (const [index, stage] of stages.entries()) {
      stage.on("error", () => this.#abandon());
      const next = stages[index + 1];
      if (next !== undefined) {
        stage.pipe(next);
      }
    }
    // The last stage runs in flowing mode, which pulls the whole chain forward.
    last.on("data", (chunk: Buffer) => {
      if (!this.#failed) {
        this.#deliver(chunk);
      }
    });
    last.on("end", () => {
      this.#settle();
    });
    this.#stages = stages;
    this.#first = first;
    return first;
  }

  #deliver(chunk: Buffer): void {
    try {
      this.#sink(chunk);
    } catch {
      // The capture can refuse a chunk (it throws once finalized). Dropping the
      // rest of the body is safer than unwinding a stream event with an
      // exception nobody listens for.
      this.#abandon();
    }
  }

  #abandon(): void {
    this.#failed = true;
    for (const stage of this.#stages) {
      stage.destroy();
    }
    this.#stages = [];
    this.#first = undefined;
    this.#settle();
  }
}

export function createResponseBodyDecoder(
  contentEncoding: string | string[] | undefined,
  sink: ResponseBodySink,
): ResponseBodyDecoder {
  return new EncodedResponseBodyDecoder(parseContentEncoding(contentEncoding), sink);
}
