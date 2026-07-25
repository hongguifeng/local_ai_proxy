import { mkdir, open, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const DEFAULT_BODY_MEMORY_THRESHOLD_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;

export interface BodyCollectorOptions {
  readonly memoryThresholdBytes?: number;
  readonly maxBytes?: number;
  readonly spoolDirectory?: string;
}

export interface CollectedBody {
  readonly sizeBytes: number;
  readonly spooled: boolean;
  bytes(): Promise<Buffer>;
  cleanup(): Promise<void>;
}

export class RequestBodyTooLargeError extends Error {
  readonly limitBytes: number;
  readonly sizeBytes: number;

  constructor(sizeBytes: number, limitBytes: number) {
    super(`Request body exceeds the ${limitBytes} byte limit.`);
    this.name = "RequestBodyTooLargeError";
    this.sizeBytes = sizeBytes;
    this.limitBytes = limitBytes;
  }
}

export async function collectBody(
  source: AsyncIterable<Uint8Array | string>,
  options: BodyCollectorOptions = {},
): Promise<CollectedBody> {
  const memoryThreshold = options.memoryThresholdBytes ?? DEFAULT_BODY_MEMORY_THRESHOLD_BYTES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  if (memoryThreshold < 0 || maxBytes < 1 || memoryThreshold > maxBytes) {
    throw new RangeError("Body collector limits must satisfy 0 <= memory threshold <= max bytes.");
  }
  const chunks: Buffer[] = [];
  let sizeBytes = 0;
  let spoolPath: string | undefined;
  let spoolFile: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // IncomingMessage 是 AsyncIterable，可用 for await...of 按块消费请求体，
    // 无需一次性等待全部数据到达。
    for await (const value of source) {
      const chunk = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
      sizeBytes += chunk.byteLength;
      if (sizeBytes > maxBytes) {
        throw new RequestBodyTooLargeError(sizeBytes, maxBytes);
      }
      if (spoolFile === undefined && sizeBytes > memoryThreshold) {
        // 小请求留在内存中速度更快；超过阈值后把已收集和后续分块转存临时文件，
        // 避免多个大请求同时到来时占满堆内存。
        const spoolDirectory = options.spoolDirectory ?? path.join(os.tmpdir(), "llm-proxy-spool");
        await mkdir(spoolDirectory, { mode: 0o700, recursive: true });
        spoolPath = path.join(spoolDirectory, `request-${randomUUID()}.tmp`);
        spoolFile = await open(spoolPath, "wx", 0o600);
        for (const buffered of chunks.splice(0)) {
          await spoolFile.write(buffered);
        }
      }
      if (spoolFile === undefined) {
        chunks.push(chunk);
      } else {
        await spoolFile.write(chunk);
      }
    }
    await spoolFile?.close();
    spoolFile = undefined;
    if (spoolPath === undefined) {
      const body = Buffer.concat(chunks, sizeBytes);
      return {
        sizeBytes,
        spooled: false,
        bytes: () => Promise.resolve(body),
        cleanup: () => Promise.resolve(),
      };
    }
    const completedPath = spoolPath;
    return {
      sizeBytes,
      spooled: true,
      bytes: () => readFile(completedPath),
      cleanup: async () => rm(completedPath, { force: true }),
    };
  } catch (error) {
    // 异常路径也要关闭句柄并删掉临时文件，这类清理通常应与资源创建写在同一函数中。
    await spoolFile?.close();
    if (spoolPath !== undefined) {
      await rm(spoolPath, { force: true });
    }
    throw error;
  }
}
