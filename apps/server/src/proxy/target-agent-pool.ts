import * as http from "node:http";
import * as https from "node:https";

import type { RuntimeTarget } from "../config/schema.js";

export interface TargetAgentPoolOptions {
  maxSockets?: number;
  maxFreeSockets?: number;
  keepAliveMsecs?: number;
}

export interface AgentPoolDiagnostics {
  origins: number;
  activeSockets: number;
  freeSockets: number;
  queuedRequests: number;
}

export class TargetAgentPool {
  readonly #agents = new Map<string, http.Agent | https.Agent>();
  readonly #options: Required<TargetAgentPoolOptions>;

  public constructor(options: TargetAgentPoolOptions = {}) {
    this.#options = {
      maxSockets: options.maxSockets ?? 64,
      maxFreeSockets: options.maxFreeSockets ?? 8,
      keepAliveMsecs: options.keepAliveMsecs ?? 1_000,
    };
    for (const [name, value] of Object.entries(this.#options)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid agent option: ${name}`);
    }
  }

  public agentFor(target: RuntimeTarget): http.Agent | https.Agent {
    const key = `${target.endpoint.protocol}//${target.endpoint.hostname}:${target.endpoint.port.toString()}`;
    let agent = this.#agents.get(key);
    if (!agent) {
      const options = { keepAlive: true, ...this.#options };
      agent = target.endpoint.protocol === "https:" ? new https.Agent(options) : new http.Agent(options);
      this.#agents.set(key, agent);
    }
    return agent;
  }

  public diagnostics(): AgentPoolDiagnostics {
    let activeSockets = 0;
    let freeSockets = 0;
    let queuedRequests = 0;
    for (const agent of this.#agents.values()) {
      activeSockets += entryCount(agent.sockets);
      freeSockets += entryCount(agent.freeSockets);
      queuedRequests += entryCount(agent.requests);
    }
    return { origins: this.#agents.size, activeSockets, freeSockets, queuedRequests };
  }

  public destroy(): void {
    for (const agent of this.#agents.values()) agent.destroy();
    this.#agents.clear();
  }
}

function entryCount(entries: Readonly<Record<string, readonly unknown[] | undefined>>): number {
  return Object.values(entries).reduce((total, values) => total + (values?.length ?? 0), 0);
}
