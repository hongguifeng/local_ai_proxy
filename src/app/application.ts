export type ApplicationState = "created" | "starting" | "running" | "stopping" | "stopped";

export interface ApplicationLifecycle {
  readonly start?: () => Promise<void> | void;
  readonly stop?: () => Promise<void> | void;
}

/**
 * 一个很小的应用状态机。
 *
 * 把启动/停止规则集中在这里后，CLI、Electron 和测试都能复用同一套生命周期，
 * 而不用各自判断“是否已经启动”或“是否正在停止”。
 */
export class Application {
  readonly #lifecycle: ApplicationLifecycle;
  #state: ApplicationState = "created";

  constructor(lifecycle: ApplicationLifecycle = {}) {
    this.#lifecycle = lifecycle;
  }

  get state(): ApplicationState {
    return this.#state;
  }

  async start(): Promise<void> {
    if (this.#state === "running") {
      return;
    }
    if (this.#state !== "created" && this.#state !== "stopped") {
      throw new Error(`Cannot start application while state is ${this.#state}.`);
    }
    this.#state = "starting";
    try {
      await this.#lifecycle.start?.();
      this.#state = "running";
    } catch (error) {
      // 启动只要有一步失败，就回到可再次启动的 stopped 状态，并保留原始异常。
      this.#state = "stopped";
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#state === "created" || this.#state === "stopped") {
      this.#state = "stopped";
      return;
    }
    if (this.#state !== "running") {
      throw new Error(`Cannot stop application while state is ${this.#state}.`);
    }
    this.#state = "stopping";
    try {
      await this.#lifecycle.stop?.();
    } finally {
      // 即使某个清理动作失败，也不能让状态永远停留在 stopping。
      this.#state = "stopped";
    }
  }
}
