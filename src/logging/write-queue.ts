import path from "node:path";

export class SerialWriteQueue {
  #tail: Promise<void> = Promise.resolve();

  enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const LOG_ROOT_QUEUES = new Map<string, SerialWriteQueue>();

export function writeQueueForLogRoot(logRoot: string): SerialWriteQueue {
  const key = path.resolve(logRoot);
  const existing = LOG_ROOT_QUEUES.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const queue = new SerialWriteQueue();
  LOG_ROOT_QUEUES.set(key, queue);
  return queue;
}
