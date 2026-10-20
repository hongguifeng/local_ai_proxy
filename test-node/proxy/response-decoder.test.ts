import {
  brotliCompressSync,
  deflateRawSync,
  deflateSync,
  gzipSync,
  zstdCompressSync,
} from "node:zlib";

import { describe, expect, it } from "vitest";

import { createResponseBodyDecoder } from "../../src/proxy/response-decoder.js";

const PLAIN_TEXT = Array.from({ length: 40 }, (_, index) => `data: chunk ${index}\n\n`).join("");

function collect(chunks: readonly Buffer[], sliceBytes: number): Buffer[] {
  const slices: Buffer[] = [];
  for (const chunk of chunks) {
    for (let offset = 0; offset < chunk.byteLength; offset += sliceBytes) {
      slices.push(chunk.subarray(offset, Math.min(offset + sliceBytes, chunk.byteLength)));
    }
  }
  return slices;
}

async function decode(chunks: readonly Buffer[], contentEncoding: string): Promise<Buffer> {
  const decoded: Buffer[] = [];
  const decoder = createResponseBodyDecoder(contentEncoding, (chunk) => decoded.push(chunk));
  for (const chunk of chunks) {
    decoder.push(chunk);
  }
  await decoder.finish();
  return Buffer.concat(decoded);
}

const CODECS = {
  br: brotliCompressSync,
  deflate: deflateSync,
  "deflate-raw": deflateRawSync,
  gzip: gzipSync,
  zstd: zstdCompressSync,
} as const;

describe("createResponseBodyDecoder", () => {
  it("decodes every content encoding the upstream can send, split mid-block", async () => {
    for (const [label, encode] of Object.entries(CODECS)) {
      const contentEncoding = label === "deflate-raw" ? "deflate" : label;
      const encoded = encode(Buffer.from(PLAIN_TEXT, "utf8"));
      const decoded = await decode(collect([encoded], 7), contentEncoding);
      expect(decoded.toString("utf8"), label).toBe(PLAIN_TEXT);
    }
  });

  it("tells zlib framed deflate from raw deflate", async () => {
    expect(await decode([deflateSync(Buffer.from(PLAIN_TEXT, "utf8"))], "deflate")).toEqual(
      Buffer.from(PLAIN_TEXT, "utf8"),
    );
    expect(await decode([deflateRawSync(Buffer.from(PLAIN_TEXT, "utf8"))], "deflate")).toEqual(
      Buffer.from(PLAIN_TEXT, "utf8"),
    );
  });

  it("undoes layered encodings in the reverse order they were applied", async () => {
    const layered = gzipSync(brotliCompressSync(Buffer.from(PLAIN_TEXT, "utf8")));
    expect(await decode([layered], "br, gzip")).toEqual(Buffer.from(PLAIN_TEXT, "utf8"));
  });

  it("passes an uncompressed body through untouched", async () => {
    for (const contentEncoding of ["", "identity", "Identity, identity"]) {
      expect(await decode([Buffer.from(PLAIN_TEXT, "utf8")], contentEncoding)).toEqual(
        Buffer.from(PLAIN_TEXT, "utf8"),
      );
    }
  });

  it("logs the encoded bytes when the runtime cannot decode the encoding", async () => {
    const encoded = gzipSync(Buffer.from(PLAIN_TEXT, "utf8"));
    const decoded = await decode([encoded], "compress");
    expect(decoded).toEqual(encoded);
    expect(decoded.toString("utf8")).not.toBe(PLAIN_TEXT);
  });

  it("joins a repeated header value", async () => {
    const encoded = gzipSync(Buffer.from(PLAIN_TEXT, "utf8"));
    const decoded: Buffer[] = [];
    const decoder = createResponseBodyDecoder(["gzip"], (chunk) => decoded.push(chunk));
    decoder.push(encoded);
    await decoder.finish();
    expect(Buffer.concat(decoded).toString("utf8")).toBe(PLAIN_TEXT);
  });

  it("keeps the decoded prefix and settles when the stream is damaged", async () => {
    const encoded = gzipSync(Buffer.from(PLAIN_TEXT, "utf8"));
    const corrupt = Buffer.from(encoded);
    corrupt.subarray(encoded.byteLength - 8).fill(0);
    const damaged: Record<string, Buffer> = {
      truncated: encoded.subarray(0, Math.floor(encoded.byteLength / 2)),
      "corrupt trailer": corrupt,
    };
    for (const [label, body] of Object.entries(damaged)) {
      const decoded: Buffer[] = [];
      const decoder = createResponseBodyDecoder("gzip", (chunk) => decoded.push(chunk));
      decoder.push(body);
      await expect(decoder.finish(), label).resolves.toBeUndefined();
      const text = Buffer.concat(decoded).toString("utf8");
      // A damaged stream must never throw, hang, or pretend the body arrived.
      expect(PLAIN_TEXT.startsWith(text), label).toBe(true);
      expect(text, label).not.toBe(PLAIN_TEXT);
    }
  });

  it("stops delivering once the sink refuses a chunk", async () => {
    const encoded = gzipSync(Buffer.from(PLAIN_TEXT, "utf8"));
    const decoded: Buffer[] = [];
    const decoder = createResponseBodyDecoder("gzip", () => {
      throw new Error("capture already finalized");
    });
    decoder.push(encoded);
    await expect(decoder.finish()).resolves.toBeUndefined();
    decoder.push(encoded);
    decoder.push(encoded);
    decoder.push(encoded);
    expect(decoded).toEqual([]);
  });

  it("settles without calling the sink for an empty body", async () => {
    const decoded: Buffer[] = [];
    const decoder = createResponseBodyDecoder("gzip", (chunk) => decoded.push(chunk));
    await expect(decoder.finish()).resolves.toBeUndefined();
    await decoder.finish();
    decoder.push(Buffer.from("late chunk"));
    expect(decoded).toEqual([]);
  });
});
