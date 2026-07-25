import path from "node:path";

export class SerialWriteQueue {
  #tail: Promise<void> = Promise.resolve();

  enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    // 成功和失败都继续执行下一项，避免某次写入失败后整条 Promise 链永久短路。
    // 返回 result 仍会把本次错误交给调用者；#tail 只负责维持队列可继续运行。
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async drain(): Promise<void> {
    await this.#tail;
  }
}

const LOG_ROOT_QUEUES = new Map<string, SerialWriteQueue>();

export function writeQueueForLogRoot(logRoot: string): SerialWriteQueue {
  // 同一个日志目录可能被多个代理目标共享。按绝对路径复用队列，可把 SQLite 写入串行化。
  const key = path.resolve(logRoot);
  const existing = LOG_ROOT_QUEUES.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const queue = new SerialWriteQueue();
  LOG_ROOT_QUEUES.set(key, queue);
  return queue;
}
