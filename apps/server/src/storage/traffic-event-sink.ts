import { TrafficEventReducer, type TrafficEvent } from "./traffic-events.js";
import type { StorageQueueResult, StorageWriteEvent } from "./write-queue.js";

export interface TrafficStorageQueue {
  enqueue(event: StorageWriteEvent): StorageQueueResult;
}

export class QueuedTrafficEventSink {
  readonly #queue: TrafficStorageQueue;
  readonly #reducer: TrafficEventReducer;

  public constructor(queue: TrafficStorageQueue, reducer = new TrafficEventReducer()) {
    this.#queue = queue;
    this.#reducer = reducer;
  }

  public emit(event: TrafficEvent): void {
    const record = this.#reducer.apply(event);
    if (!record) return;
    this.#queue.enqueue({ record });
    if (event.kind === "finished" || event.kind === "error") this.#reducer.forget(event.requestId);
  }
}

export class NoopTrafficEventSink {
  public emit(event: TrafficEvent): void {
    void event;
  }
}
