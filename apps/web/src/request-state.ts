export class LatestRequest {
  #generation = 0;
  #controller: AbortController | null = null;

  public async run<Value>(operation: (signal: AbortSignal) => Promise<Value>): Promise<Value | undefined> {
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    const generation = ++this.#generation;
    try {
      const value = await operation(controller.signal);
      return generation === this.#generation ? value : undefined;
    } catch (error) {
      if (controller.signal.aborted || generation !== this.#generation) return undefined;
      throw error;
    }
  }

  public cancel(): void {
    this.#generation += 1;
    this.#controller?.abort();
    this.#controller = null;
  }
}
