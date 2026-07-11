import type {
  CapturedPayload,
  PublicProxy,
  PublicTarget,
  RecordDetail,
  RecordSummary,
  TaskSummary,
} from "@llm-proxy/contracts";

import { ApiClient } from "./api-client.js";
import "./style.css";
import { AdminUiController, type UiState } from "./ui-controller.js";

const elements = {
  error: required("error"),
  notice: required("notice"),
  proxies: required("proxies"),
  historyTree: required("history-tree"),
  taskCount: required("task-count"),
  detailSummary: required("detail-summary"),
  requestMeta: required("request-meta"),
  responseMeta: required("response-meta"),
  requestDetail: required("request-detail"),
  responseDetail: required("response-detail"),
  export: required("export") as HTMLAnchorElement,
  cleanup: required("cleanup") as HTMLButtonElement,
  save: required("save-proxies") as HTMLButtonElement,
  tasksPrev: required("tasks-prev") as HTMLButtonElement,
  tasksNext: required("tasks-next") as HTMLButtonElement,
  query: required("query") as HTMLInputElement,
  logsView: required("logs-view"),
  historySplitter: required("history-splitter"),
};
const controller = new AdminUiController(new ApiClient(), render);
let selectedRecordId: string | null = null;

document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    activateView(tab);
  });
});
required("refresh").addEventListener("click", () => void refresh());
elements.save.addEventListener("click", () => void controller.saveProxies());
required("add-proxy").addEventListener("click", () => {
  controller.addProxy();
});
elements.tasksPrev.addEventListener(
  "click",
  () => void controller.searchTasks(elements.query.value, Math.max(0, (controller.state.tasks?.offset ?? 0) - 50)),
);
elements.tasksNext.addEventListener(
  "click",
  () => void controller.searchTasks(elements.query.value, (controller.state.tasks?.offset ?? 0) + 50),
);
required("task-search").addEventListener("submit", (event) => {
  event.preventDefault();
  selectedRecordId = null;
  void controller.searchTasks(elements.query.value);
});
elements.cleanup.addEventListener("click", () => {
  if (window.confirm("确定要永久清理所选任务及其请求记录吗？")) void controller.cleanupSelected();
});
document.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((button) => {
  button.addEventListener("click", () => {
    const source = button.dataset.copy === "request" ? elements.requestDetail : elements.responseDetail;
    void navigator.clipboard.writeText(source.textContent);
  });
});
document.querySelectorAll<HTMLButtonElement>("[data-meta-toggle]").forEach((button) => {
  button.addEventListener("click", () => {
    const panel = button.dataset.metaToggle === "request" ? elements.requestMeta : elements.responseMeta;
    panel.hidden = !panel.hidden;
    button.classList.toggle("active", !panel.hidden);
  });
});
installHistorySplitter();
void refresh();

async function refresh(): Promise<void> {
  await Promise.all([controller.loadProxies(), controller.searchTasks(elements.query.value)]);
}

function activateView(tab: HTMLButtonElement): void {
  document.querySelectorAll(".tab, .view").forEach((element) => {
    element.classList.remove("active");
  });
  tab.classList.add("active");
  const view = tab.dataset.view;
  if (view) document.getElementById(view)?.classList.add("active");
}

function installHistorySplitter(): void {
  let dragging = false;
  elements.historySplitter.addEventListener("pointerdown", (event) => {
    dragging = true;
    elements.historySplitter.setPointerCapture(event.pointerId);
  });
  elements.historySplitter.addEventListener("pointermove", (event) => {
    if (!dragging || window.innerWidth <= 900) return;
    const bounds = elements.logsView.getBoundingClientRect();
    const width = Math.max(360, Math.min(bounds.width - 420, event.clientX - bounds.left));
    elements.logsView.style.setProperty("--history-width", `${String(width)}px`);
  });
  elements.historySplitter.addEventListener("pointerup", () => {
    dragging = false;
  });
}

function render(state: UiState): void {
  elements.error.hidden = state.error === null;
  elements.error.textContent = state.error ?? "";
  elements.notice.hidden = state.notice === null;
  elements.notice.textContent = state.notice ?? "";
  elements.save.disabled = state.loading.mutation;
  elements.tasksPrev.disabled = state.loading.tasks || !state.tasks || state.tasks.offset === 0;
  elements.tasksNext.disabled = state.loading.tasks || !state.tasks?.hasMore;
  elements.proxies.replaceChildren(
    ...(state.proxies.length > 0 ? state.proxies.map(proxyCard) : [empty("还没有代理，点击“添加代理”开始配置。")]),
  );

  const tasks = state.tasks?.tasks ?? [];
  elements.taskCount.textContent = state.tasks ? `${String(state.tasks.total)} 项` : "";
  elements.historyTree.replaceChildren(
    ...(tasks.length > 0
      ? tasks.map(({ task, logRoot }) => taskGroup(task, logRoot, state))
      : [empty(state.loading.tasks ? "正在加载任务…" : state.stale ? "任务数据可能已过期" : "没有匹配的任务")]),
  );
  renderDetail(state.detail, state.loading.detail);

  const exportUrl = controller.exportUrl(elements.query.value);
  elements.export.hidden = exportUrl === null;
  if (exportUrl) elements.export.href = exportUrl;
  elements.cleanup.disabled = state.selectedTask === null || state.loading.mutation;
}

function proxyCard(proxy: PublicProxy): HTMLElement {
  const card = article("proxy-card");
  card.dataset.proxyId = proxy.id;
  const head = div("proxy-head");
  head.append(
    labeledInput("代理名称", proxy.name, (value) => {
      controller.updateProxy(proxy.id, { name: value });
    }),
    labeledInput("监听地址", proxy.listenHost, (value) => {
      controller.updateProxy(proxy.id, { listenHost: value });
    }),
    labeledNumber("端口", proxy.listenPort, 0, 65_535, (value) => {
      controller.updateProxy(proxy.id, { listenPort: value });
    }),
    proxyStatus(proxy),
  );
  const options = div("proxy-options");
  options.append(
    checkbox("启用监听", proxy.enabled, (checked) => void controller.toggleProxy(proxy.id, checked)),
    checkbox("访问日志", proxy.accessLog, (checked) => {
      controller.updateProxy(proxy.id, { accessLog: checked });
    }),
  );
  const targets = div("targets");
  targets.append(...proxy.targets.map((target) => targetCard(proxy, target)));
  const actions = div("card-actions");
  const addTarget = button("＋ 添加转发目标", () => {
    controller.addTarget(proxy.id);
  });
  const remove = button(
    "删除代理",
    () => {
      controller.removeProxy(proxy.id);
    },
    "danger",
  );
  actions.append(addTarget, remove);
  card.append(head, options, targets, actions);
  return card;
}

function proxyStatus(proxy: PublicProxy): HTMLElement {
  const box = div("proxy-status");
  const dot = document.createElement("span");
  dot.className = `status-dot ${proxy.runtime.state}`;
  const text = document.createElement("span");
  text.className = "status-text";
  text.textContent = `${proxy.runtime.state} · ${proxy.listenHost}:${String(proxy.runtime.actualListenPort ?? proxy.listenPort)}`;
  box.append(dot, text);
  return box;
}

function targetCard(proxy: PublicProxy, target: PublicTarget): HTMLElement {
  const card = article("target-card");
  card.dataset.targetId = target.id;
  const head = div("target-head");
  head.append(
    labeledInput("目标名称", target.name, (value) => {
      controller.updateTarget(proxy.id, target.id, { name: value });
    }),
    checkbox(
      "默认",
      proxy.defaultTargetId === target.id,
      (checked) => {
        if (checked) controller.setDefaultTarget(proxy.id, target.id);
      },
      "radio",
    ),
  );
  const main = div("target-row");
  main.append(
    labeledInput("转发地址", target.url, (value) => {
      controller.updateTarget(proxy.id, target.id, { url: value });
    }),
    checkbox(
      "启用目标",
      target.enabled,
      (checked) => {
        controller.updateTarget(proxy.id, target.id, { enabled: checked });
      },
      "checkbox",
      proxy.defaultTargetId === target.id,
    ),
  );
  const secret = div("secret-row");
  const secretInput = document.createElement("input");
  secretInput.type = "password";
  secretInput.placeholder = target.apiKey.configured
    ? `已配置 ${target.apiKey.masked ?? ""}；留空并设置可清除`
    : "输入新的 API Key";
  secret.append(
    field("API Key", secretInput),
    button("设置", () => {
      const value = secretInput.value;
      controller.setTargetSecret(proxy.id, target.id, value ? "replace" : "clear", value);
    }),
  );

  const mappings = labeledTextarea(
    "模型映射（每行 监听模型 => 上游模型）",
    mappingsText(target.modelMappings),
    (value) => {
      controller.updateTarget(proxy.id, target.id, { modelMappings: parseMappings(value) });
    },
  );

  const details = document.createElement("details");
  details.className = "target-options";
  const summary = document.createElement("summary");
  summary.textContent = "更多配置";
  const body = div("target-options");
  body.append(
    labeledTextarea("上游 Headers（每行 Name: value）", headersText(target.headers), (value) => {
      controller.updateTarget(proxy.id, target.id, { headers: parseHeaders(value) });
    }),
    labeledTextarea("移除请求字段（逗号或换行分隔）", target.stripRequestFields.join("\n"), (value) => {
      controller.updateTarget(proxy.id, target.id, { stripRequestFields: splitLines(value) });
    }),
    labeledTextarea("注入请求字段（JSON object）", JSON.stringify(target.injectRequestFields, null, 2), (value) => {
      const parsed = parseObject(value);
      if (parsed) controller.updateTarget(proxy.id, target.id, { injectRequestFields: parsed });
    }),
    timeoutFields(proxy.id, target),
    labeledInput("日志目录（留空使用默认目录）", target.logRoot ?? "", (value) => {
      controller.updateTarget(proxy.id, target.id, { logRoot: value.trim() || null });
    }),
    checkbox("日志脱敏", target.redactLogs, (checked) => {
      controller.updateTarget(proxy.id, target.id, { redactLogs: checked });
    }),
  );
  details.append(summary, body);
  const actions = div("target-actions");
  actions.append(
    button(
      "删除目标",
      () => {
        controller.removeTarget(proxy.id, target.id);
      },
      "danger",
    ),
  );
  card.append(head, main, secret, mappings, details, actions);
  return card;
}

function timeoutFields(proxyId: string, target: PublicTarget): HTMLElement {
  const grid = div("timeout-grid");
  grid.append(
    labeledNumber("连接超时 ms", target.timeouts.connectMs, 100, 120_000, (value) => {
      controller.updateTarget(proxyId, target.id, { timeouts: { ...target.timeouts, connectMs: value } });
    }),
    labeledNumber("响应头超时 ms", target.timeouts.responseHeadersMs, 100, 600_000, (value) => {
      controller.updateTarget(proxyId, target.id, { timeouts: { ...target.timeouts, responseHeadersMs: value } });
    }),
    labeledNumber("空闲超时 ms", target.timeouts.idleMs, 1_000, 3_600_000, (value) => {
      controller.updateTarget(proxyId, target.id, { timeouts: { ...target.timeouts, idleMs: value } });
    }),
  );
  return grid;
}

function taskGroup(task: TaskSummary, logRoot: string, state: UiState): HTMLElement {
  const active = state.selectedTask?.id === task.id;
  const group = document.createElement("section");
  group.className = "history-group";
  const head = document.createElement("button");
  head.type = "button";
  head.className = `history-group-head${active ? " active" : ""}`;
  head.append(
    text("history-caret", active ? "▾" : "▸"),
    text("history-title", `${task.model ?? task.kind} · ${task.endpoint}`),
    text(
      "history-meta",
      `${formatTime(task.lastSeenAt)} | ${String(task.requestCount)} 个请求 | ${task.pending ? "进行中" : (task.target ?? "未路由")}`,
    ),
  );
  head.addEventListener("click", () => {
    selectedRecordId = null;
    void controller.selectTask(logRoot, task.id);
  });
  group.append(head);
  if (active) {
    const records = div("history-group-records");
    if (state.loading.records) records.append(text("history-group-placeholder", "正在加载请求…"));
    else if (!state.records || state.records.records.length === 0)
      records.append(text("history-group-placeholder", "该任务没有请求记录"));
    else records.append(...state.records.records.map((record) => recordButton(record, selectedRecordId === record.id)));
    group.append(records);
  }
  return group;
}

function recordButton(record: RecordSummary, active: boolean): HTMLButtonElement {
  const control = historyButton(active);
  const counters = [
    record.messageCount === null ? "" : `${String(record.messageCount)} 条消息`,
    record.tokenCount === null ? "" : `${String(record.tokenCount)} tokens`,
  ].filter(Boolean);
  control.append(
    text("history-title", `${record.method} ${record.path}`),
    text(
      "history-meta",
      `${formatTime(record.timestamp)} | ${statusText(record)} | ${formatDuration(record.durationMs)}`,
    ),
    ...(counters.length > 0 ? [text("history-meta", counters.join(" | "))] : []),
  );
  control.addEventListener("click", () => {
    selectedRecordId = record.id;
    void controller.selectRecord(record.id);
  });
  return control;
}

function statusText(record: RecordSummary): string {
  if (record.status !== null) return String(record.status);
  if (record.errorCode) return record.errorCode;
  return record.event === "request_received" ? "等待中" : record.event;
}

function renderDetail(detail: RecordDetail | null, loading: boolean): void {
  if (loading) {
    elements.detailSummary.textContent = "正在加载详情…";
    return;
  }
  if (!detail) {
    elements.detailSummary.textContent = "选择一条请求查看详情";
    elements.requestMeta.textContent = "";
    elements.responseMeta.textContent = "";
    placeholder(elements.requestDetail, "暂无请求内容");
    placeholder(elements.responseDetail, "暂无响应内容");
    return;
  }
  elements.detailSummary.textContent = `${detail.method} ${detail.path} · ${String(detail.status ?? "未完成")} · ${formatDuration(detail.durationMs)} · ${detail.proxy.name} → ${detail.target.name}`;
  elements.requestMeta.textContent = `客户端 ${detail.client.host}:${String(detail.client.port)}\nHeaders\n${headersText(detail.request.headers)}`;
  renderJson(elements.requestDetail, payloadValue(detail.request.body, detail.request.headers, false));
  elements.responseMeta.textContent = detail.response
    ? `Headers\n${headersText(detail.response.headers)}`
    : "请求尚无响应";
  if (detail.response)
    renderJson(elements.responseDetail, payloadValue(detail.response.body, detail.response.headers, true));
  else placeholder(elements.responseDetail, "暂无响应内容");
}

function payloadValue(
  payload: CapturedPayload,
  headers: Readonly<Record<string, readonly string[]>>,
  aggregateStream: boolean,
): unknown {
  const capture = {
    observedBytes: payload.observedBytes,
    capturedBytes: payload.capturedBytes,
    truncated: payload.truncated,
  };
  if (payload.kind === "empty") return { capture, body: null };
  if (payload.kind === "json") return { capture, body: payload.value };
  if (payload.kind === "binary") return { capture, body: { encoding: "base64", value: payload.base64 } };
  if (aggregateStream && contentType(headers).includes("text/event-stream"))
    return { capture, body: summarizeEventStream(payload.text) };
  return { capture, body: payload.text };
}

function contentType(headers: Readonly<Record<string, readonly string[]>>): string {
  return Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1]?.[0] ?? "";
}

function summarizeEventStream(textValue: string): Record<string, unknown> {
  const content: string[] = [];
  const reasoning: string[] = [];
  const finishReasons = new Set<string>();
  let usage: unknown;
  let eventCount = 0;
  let doneSeen = false;
  for (const line of textValue.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === "[DONE]") {
      doneSeen = true;
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(data) as unknown;
    } catch {
      continue;
    }
    eventCount += 1;
    collectStreamEvent(event, content, reasoning, finishReasons, (value) => {
      usage = value;
    });
  }
  return {
    streamSummary: {
      eventCount,
      doneSeen,
      ...(content.length > 0 ? { content: content.join("") } : {}),
      ...(reasoning.length > 0 ? { reasoning: reasoning.join("") } : {}),
      ...(finishReasons.size > 0 ? { finishReasons: [...finishReasons] } : {}),
      ...(usage === undefined ? {} : { usage }),
    },
  };
}

function collectStreamEvent(
  event: unknown,
  content: string[],
  reasoning: string[],
  finishReasons: Set<string>,
  setUsage: (value: unknown) => void,
): void {
  if (!event || typeof event !== "object") return;
  const value = event as Record<string, unknown>;
  const type = typeof value.type === "string" ? value.type : "";
  const delta = value.delta;
  if (typeof delta === "string") {
    if (type.includes("reasoning") || type.includes("thinking")) reasoning.push(delta);
    else content.push(delta);
  } else if (delta && typeof delta === "object") {
    const fields = delta as Record<string, unknown>;
    if (typeof fields.text === "string") content.push(fields.text);
    if (typeof fields.thinking === "string") reasoning.push(fields.thinking);
    if (typeof fields.stop_reason === "string") finishReasons.add(fields.stop_reason);
  }
  if (typeof value.text === "string" && type.includes("text")) content.push(value.text);
  if (typeof value.output_text === "string") content.push(value.output_text);
  if (typeof value.finish_reason === "string") finishReasons.add(value.finish_reason);
  if (typeof value.stop_reason === "string") finishReasons.add(value.stop_reason);
  if (value.usage !== undefined) setUsage(value.usage);
  if (value.response && typeof value.response === "object") {
    const response = value.response as Record<string, unknown>;
    if (response.usage !== undefined) setUsage(response.usage);
    collectResponseOutput(response.output, content, reasoning);
    if (typeof response.status === "string") finishReasons.add(response.status);
  }
}

function collectResponseOutput(output: unknown, content: string[], reasoning: string[]): void {
  if (!Array.isArray(output)) return;
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    const target = value.type === "reasoning" ? reasoning : content;
    if (typeof value.text === "string") target.push(value.text);
    if (!Array.isArray(value.content)) continue;
    for (const part of value.content) {
      if (!part || typeof part !== "object") continue;
      const textValue = (part as Record<string, unknown>).text;
      if (typeof textValue === "string") target.push(textValue);
    }
  }
}

function renderJson(container: HTMLElement, value: unknown): void {
  const root = div("json-node");
  root.append(jsonNode(value, "", 0));
  container.replaceChildren(root);
}

function jsonNode(value: unknown, key: string, depth: number): HTMLElement {
  if (Array.isArray(value) || (value !== null && typeof value === "object")) {
    const entries = Array.isArray(value)
      ? value.map((item, index) => [String(index), item] as const)
      : Object.entries(value);
    const details = document.createElement("details");
    details.open = depth < 2;
    const summary = document.createElement("summary");
    if (key) summary.append(jsonKey(key), ": ");
    const start = Array.isArray(value) ? "[" : "{";
    const end = Array.isArray(value) ? "]" : "}";
    summary.append(start, text("json-muted", ` ${String(entries.length)} 项 `), end);
    const children = div("json-children");
    for (const [childKey, childValue] of entries) {
      const row = div("json-row");
      row.append(jsonNode(childValue, childKey, depth + 1));
      children.append(row);
    }
    details.append(summary, children);
    return details;
  }
  const row = document.createElement("span");
  if (key) row.append(jsonKey(key), ": ");
  if (typeof value === "string") {
    if (value.length > 200 || value.includes("\n")) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.append(text("json-string", JSON.stringify(value.slice(0, 140)) + (value.length > 140 ? "…" : "")));
      const body = document.createElement("pre");
      body.className = "json-long-string";
      body.textContent = value;
      details.append(summary, body);
      row.append(details);
    } else row.append(text("json-string", JSON.stringify(value)));
  } else if (typeof value === "number") row.append(text("json-number", String(value)));
  else if (typeof value === "boolean") row.append(text("json-boolean", String(value)));
  else row.append(text("json-null", value === undefined ? "undefined" : "null"));
  return row;
}

function jsonKey(key: string): HTMLElement {
  return text("json-key", JSON.stringify(key));
}

function placeholder(container: HTMLElement, value: string): void {
  container.replaceChildren(text("json-muted", value));
}

function labeledInput(label: string, value: string, update: (value: string) => void): HTMLElement {
  const input = document.createElement("input");
  input.value = value;
  input.addEventListener("input", () => {
    update(input.value);
  });
  return field(label, input);
}
function labeledNumber(
  label: string,
  value: number,
  min: number,
  max: number,
  update: (value: number) => void,
): HTMLElement {
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  input.addEventListener("input", () => {
    if (input.value !== "") update(Number(input.value));
  });
  return field(label, input);
}
function labeledTextarea(label: string, value: string, update: (value: string) => void): HTMLElement {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.addEventListener("input", () => {
    update(textarea.value);
  });
  return field(label, textarea);
}
function field(label: string, control: HTMLElement): HTMLElement {
  const wrapper = document.createElement("label");
  wrapper.className = "field";
  wrapper.append(text("", label), control);
  return wrapper;
}
function checkbox(
  label: string,
  checked: boolean,
  update: (checked: boolean) => void,
  type: "checkbox" | "radio" = "checkbox",
  disabled = false,
): HTMLElement {
  const wrapper = document.createElement("label");
  wrapper.className = "check";
  const input = document.createElement("input");
  input.type = type;
  input.checked = checked;
  input.disabled = disabled;
  input.addEventListener("change", () => {
    update(input.checked);
  });
  wrapper.append(input, label);
  return wrapper;
}
function button(label: string, action: () => void, className = ""): HTMLButtonElement {
  const control = document.createElement("button");
  control.type = "button";
  control.textContent = label;
  control.className = className;
  control.addEventListener("click", action);
  return control;
}
function historyButton(active: boolean): HTMLButtonElement {
  const control = document.createElement("button");
  control.type = "button";
  control.className = `history-item${active ? " active" : ""}`;
  return control;
}
function empty(value: string): HTMLElement {
  return text("empty", value);
}
function text(className: string, value: string): HTMLElement {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = value;
  return element;
}
function div(className: string): HTMLDivElement {
  const element = document.createElement("div");
  element.className = className;
  return element;
}
function article(className: string): HTMLElement {
  const element = document.createElement("article");
  element.className = className;
  return element;
}
function splitLines(value: string): string[] {
  return value
    .split(/[\n,]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}
function parseHeaders(value: string): { name: string; value: string }[] {
  return value.split("\n").flatMap((line) => {
    const index = line.indexOf(":");
    return index > 0 ? [{ name: line.slice(0, index).trim(), value: line.slice(index + 1).trim() }] : [];
  });
}
function headersText(
  headers: Readonly<Record<string, readonly string[]>> | readonly { name: string; value: string }[],
): string {
  if (Array.isArray(headers)) {
    return (headers as readonly { name: string; value: string }[])
      .map((header) => `${header.name}: ${header.value}`)
      .join("\n");
  }
  return Object.entries(headers as Readonly<Record<string, readonly string[]>>)
    .flatMap(([name, values]) => values.map((value) => `${name}: ${value}`))
    .join("\n");
}
function mappingsText(values: readonly { listen: string; upstream: string }[]): string {
  return values.map((value) => `${value.listen} => ${value.upstream}`).join("\n");
}
function parseMappings(value: string): { listen: string; upstream: string }[] {
  return value.split("\n").flatMap((line) => {
    const [listen, upstream] = line.split("=>", 2).map((item) => item.trim());
    return listen && upstream ? [{ listen, upstream }] : [];
  });
}
function parseObject(value: string): PublicTarget["injectRequestFields"] | null {
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as PublicTarget["injectRequestFields"])
      : null;
  } catch {
    return null;
  }
}
function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}
function formatDuration(value: number): string {
  return value < 1_000 ? `${String(Math.round(value))} ms` : `${(value / 1_000).toFixed(2)} s`;
}
function required(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element: ${id}`);
  return element;
}
