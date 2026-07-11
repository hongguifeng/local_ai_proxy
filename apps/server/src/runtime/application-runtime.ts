import type { RuntimeConfigSnapshot } from "../config/schema.js";
import { waitForAbort, type ApplicationRuntime } from "../lifecycle.js";

export interface RuntimeConfigLoader {
  load(): Promise<RuntimeConfigSnapshot>;
  close?(): Promise<void>;
}

export interface StorageRuntime {
  start(config: RuntimeConfigSnapshot): Promise<void>;
  drain(): Promise<void>;
  close(): Promise<void>;
}

export interface ProxyRuntimeGroup {
  start(config: RuntimeConfigSnapshot): Promise<void>;
  stop(): Promise<void>;
}

export interface AdminRuntime {
  start(config: RuntimeConfigSnapshot): Promise<void>;
  stop(): Promise<void>;
}

export interface ApplicationRuntimeComponents {
  config: RuntimeConfigLoader;
  storage: StorageRuntime;
  proxies: ProxyRuntimeGroup;
  admin: AdminRuntime;
}

export class OrderedApplicationRuntime implements ApplicationRuntime {
  readonly #components: ApplicationRuntimeComponents;
  #started = false;
  #stopPromise: Promise<void> | null = null;

  public constructor(components: ApplicationRuntimeComponents) {
    this.#components = components;
  }

  public async start(signal: AbortSignal): Promise<void> {
    if (this.#started) return;
    if (signal.aborted) throw new Error("Startup aborted");
    const config = await this.#components.config.load();
    let storageStarted = false;
    let proxiesStarted = false;
    try {
      await this.#components.storage.start(config);
      storageStarted = true;
      await this.#components.proxies.start(config);
      proxiesStarted = true;
      await this.#components.admin.start(config);
      this.#started = true;
    } catch (error) {
      if (proxiesStarted) await ignoreFailure(this.#components.proxies.stop());
      if (storageStarted) {
        await ignoreFailure(this.#components.storage.drain());
        await ignoreFailure(this.#components.storage.close());
      }
      await ignoreFailure(this.#components.config.close?.() ?? Promise.resolve());
      throw error;
    }
  }

  public async wait(signal: AbortSignal): Promise<void> {
    await waitForAbort(signal);
  }

  public stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopPromise = this.#stop();
    return this.#stopPromise;
  }

  async #stop(): Promise<void> {
    await ignoreFailure(this.#components.admin.stop());
    await ignoreFailure(this.#components.proxies.stop());
    await ignoreFailure(this.#components.storage.drain());
    await ignoreFailure(this.#components.storage.close());
    await ignoreFailure(this.#components.config.close?.() ?? Promise.resolve());
    this.#started = false;
  }
}

async function ignoreFailure(operation: Promise<void>): Promise<void> {
  try {
    await operation;
  } catch {
    // Shutdown continues so later resources are always released.
  }
}
