import type { RuntimeStatus } from "./runtime-manager.js";

export type ComponentHealth = "ok" | "degraded" | "failed";

export interface RuntimeHealthSnapshot {
  status: ComponentHealth;
  storage: ComponentHealth;
  storageRestartAttempts: number;
  proxies: { configured: number; running: number; failed: number };
}

export interface StorageRecoveryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  restart: () => Promise<void>;
  delay?: (milliseconds: number) => Promise<void>;
  onWarning?: (code: string, attempt: number) => void;
}

export class RuntimeRecovery {
  readonly #maxAttempts: number;
  readonly #baseDelayMs: number;
  readonly #restart: () => Promise<void>;
  readonly #delay: (milliseconds: number) => Promise<void>;
  readonly #onWarning: StorageRecoveryOptions["onWarning"];
  #storage: ComponentHealth = "ok";
  #attempts = 0;
  #recovery: Promise<void> | null = null;

  public constructor(options: StorageRecoveryOptions) {
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#baseDelayMs = options.baseDelayMs ?? 250;
    if (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts < 0 || this.#maxAttempts > 10)
      throw new RangeError("Invalid recovery attempt limit");
    if (!Number.isSafeInteger(this.#baseDelayMs) || this.#baseDelayMs < 0)
      throw new RangeError("Invalid recovery delay");
    this.#restart = options.restart;
    this.#delay = options.delay ?? delay;
    this.#onWarning = options.onWarning;
  }

  public storageCrashed(): Promise<void> {
    this.#storage = "degraded";
    if (!this.#recovery) {
      this.#recovery = this.#recover().finally(() => {
        this.#recovery = null;
      });
    }
    return this.#recovery;
  }

  public health(proxies: readonly RuntimeStatus[]): RuntimeHealthSnapshot {
    const failed = proxies.filter((proxy) => proxy.state === "failed").length;
    const running = proxies.filter((proxy) => proxy.state === "running").length;
    const status =
      this.#storage === "failed" || failed > 0 ? "failed" : this.#storage === "degraded" ? "degraded" : "ok";
    return {
      status,
      storage: this.#storage,
      storageRestartAttempts: this.#attempts,
      proxies: { configured: proxies.length, running, failed },
    };
  }

  async #recover(): Promise<void> {
    while (this.#attempts < this.#maxAttempts) {
      this.#attempts += 1;
      this.#onWarning?.("STORAGE_RESTARTING", this.#attempts);
      await this.#delay(this.#baseDelayMs * 2 ** (this.#attempts - 1));
      try {
        await this.#restart();
        this.#storage = "ok";
        this.#attempts = 0;
        return;
      } catch {
        // Retry within the finite budget.
      }
    }
    this.#storage = "failed";
    this.#onWarning?.("STORAGE_RESTART_EXHAUSTED", this.#attempts);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
