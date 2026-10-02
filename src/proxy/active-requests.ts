import type { ProxyRequestContext } from "./proxy-listener.js";

export interface ActiveRequest {
  readonly context: ProxyRequestContext;
  readonly controller: AbortController;
}

export class ActiveRequestRegistry {
  readonly #requests = new Map<string, ActiveRequest>();
  readonly #idleWaiters: (() => void)[] = [];

  begin(context: ProxyRequestContext): AbortSignal {
    if (this.#requests.has(context.id)) {
      throw new Error(`Request ${context.id} is already active.`);
    }
    const controller = new AbortController();
    this.#requests.set(context.id, { context, controller });
    return controller.signal;
  }

  end(requestId: string): void {
    this.#requests.delete(requestId);
    this.#flushIdle();
  }

  get(requestId: string): ActiveRequest | undefined {
    return this.#requests.get(requestId);
  }

  get size(): number {
    return this.#requests.size;
  }

  ids(): string[] {
    return [...this.#requests.keys()];
  }

  /** Resolves once every tracked request has released its slot. */
  idle(): Promise<void> {
    if (this.#requests.size === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#idleWaiters.push(resolve);
    });
  }

  abortAll(reason: unknown = new Error("Proxy shutdown")): void {
    for (const { controller } of this.#requests.values()) {
      controller.abort(reason);
    }
  }

  #flushIdle(): void {
    if (this.#requests.size !== 0) {
      return;
    }
    const waiters = this.#idleWaiters.splice(0, this.#idleWaiters.length);
    for (const resolve of waiters) {
      resolve();
    }
  }
}
