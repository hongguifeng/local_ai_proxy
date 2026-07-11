import type { ProxyListResponse, RecordDetail, RecordListResponse } from "@llm-proxy/contracts";

import { ApiError, type ApiClient, type TaskPage } from "./api-client.js";
import { LatestRequest } from "./request-state.js";

export interface UiState {
  proxies: ProxyListResponse["proxies"];
  tasks: TaskPage | null;
  records: RecordListResponse | null;
  detail: RecordDetail | null;
  selectedTask: { id: string; logRoot: string } | null;
  loading: Readonly<Record<"proxies" | "tasks" | "records" | "detail" | "mutation", boolean>>;
  error: string | null;
  notice: string | null;
  stale: boolean;
}

export class AdminUiController {
  readonly #api: ApiClient;
  readonly #notify: (state: UiState) => void;
  readonly #requests = {
    proxies: new LatestRequest(),
    tasks: new LatestRequest(),
    records: new LatestRequest(),
    detail: new LatestRequest(),
  };
  readonly #secretUpdates = new Map<string, { action: "keep" | "clear" | "replace"; value?: string }>();
  #state: UiState = {
    proxies: [],
    tasks: null,
    records: null,
    detail: null,
    selectedTask: null,
    loading: { proxies: false, tasks: false, records: false, detail: false, mutation: false },
    error: null,
    notice: null,
    stale: false,
  };

  public constructor(api: ApiClient, notify: (state: UiState) => void) {
    this.#api = api;
    this.#notify = notify;
  }

  public get state(): UiState {
    return this.#state;
  }

  public async loadProxies(): Promise<void> {
    await this.#load("proxies", async () => {
      const result = await this.#requests.proxies.run(async (signal) => this.#api.proxies(signal));
      if (result) this.#set({ proxies: result.proxies });
    });
  }

  public async toggleProxy(id: string, enabled: boolean): Promise<void> {
    await this.#mutation(async () => {
      const result = await this.#api.setProxyEnabled(id, enabled);
      this.#set({ proxies: result.proxies });
    });
  }

  public async saveProxies(): Promise<void> {
    await this.#mutation(async () => {
      const result = await this.#api.replaceProxies({
        proxies: this.#state.proxies.map((proxy) => ({
          id: proxy.id,
          name: proxy.name,
          enabled: proxy.enabled,
          listenHost: proxy.listenHost,
          listenPort: proxy.listenPort,
          accessLog: proxy.accessLog,
          defaultTargetId: proxy.defaultTargetId,
          targets: proxy.targets.map((target) => ({
            ...target,
            apiKey: this.#secretUpdates.get(secretKey(proxy.id, target.id)) ?? { action: "keep" },
          })),
        })),
      });
      this.#set({ proxies: result.proxies });
      this.#secretUpdates.clear();
      this.#set({ notice: "配置已保存" });
    });
  }

  public setTargetSecret(
    proxyId: string,
    targetId: string,
    action: "keep" | "clear" | "replace",
    value?: string,
  ): void {
    const update = {
      action,
      ...(action === "replace" && value ? { value } : {}),
    } as const;
    this.#secretUpdates.set(secretKey(proxyId, targetId), update);
  }

  public async searchTasks(query: string, offset = 0): Promise<void> {
    await this.#load("tasks", async () => {
      const result = await this.#requests.tasks.run(async (signal) => this.#api.tasks(query, 50, offset, signal));
      if (result) this.#set({ tasks: result, records: null, detail: null, selectedTask: null });
    });
  }

  public async selectTask(logRoot: string, taskId: string, query = ""): Promise<void> {
    this.#set({ selectedTask: { id: taskId, logRoot }, detail: null });
    await this.#load("records", async () => {
      const result = await this.#requests.records.run(async (signal) =>
        this.#api.records(logRoot, taskId, query, 50, 0, signal),
      );
      if (result) this.#set({ records: result });
    });
  }

  public async selectRecord(recordId: string): Promise<void> {
    const selected = this.#state.selectedTask;
    if (!selected) return;
    await this.#load("detail", async () => {
      const result = await this.#requests.detail.run(async (signal) =>
        this.#api.record(selected.logRoot, recordId, signal),
      );
      if (result) this.#set({ detail: result });
    });
  }

  public exportUrl(query = ""): string | null {
    const root = this.#state.selectedTask?.logRoot ?? this.#state.tasks?.tasks[0]?.logRoot;
    return root ? this.#api.exportUrl(root, query) : null;
  }

  public async cleanupSelected(): Promise<void> {
    const selected = this.#state.selectedTask;
    if (!selected) return;
    await this.#mutation(async () => {
      await this.#api.cleanup({ logRoots: [selected.logRoot], taskIds: [selected.id] });
      await this.searchTasks("");
      this.#set({ notice: "任务已清理" });
    });
  }

  async #load(key: "proxies" | "tasks" | "records" | "detail", operation: () => Promise<void>): Promise<void> {
    this.#loading(key, true);
    try {
      await operation();
      this.#set({ error: null, stale: false });
    } catch (error) {
      this.#set({ error: publicMessage(error), stale: true });
    } finally {
      this.#loading(key, false);
    }
  }

  async #mutation(operation: () => Promise<void>): Promise<void> {
    if (this.#state.loading.mutation) return;
    this.#loading("mutation", true);
    this.#set({ error: null, notice: null });
    try {
      await operation();
    } catch (error) {
      this.#set({ error: publicMessage(error) });
    } finally {
      this.#loading("mutation", false);
    }
  }

  #loading(key: keyof UiState["loading"], value: boolean): void {
    this.#set({ loading: { ...this.#state.loading, [key]: value } });
  }

  #set(values: Partial<UiState>): void {
    this.#state = { ...this.#state, ...values };
    this.#notify(this.#state);
  }
}

function secretKey(proxyId: string, targetId: string): string {
  return `${proxyId}\u0000${targetId}`;
}

function publicMessage(error: unknown): string {
  if (error instanceof ApiError && error.response && typeof error.response === "object" && "error" in error.response) {
    const detail = error.response.error;
    if (detail && typeof detail === "object" && "message" in detail && typeof detail.message === "string")
      return detail.message.slice(0, 1_000);
  }
  return "Request failed";
}
