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
  tasks: required("tasks"),
  records: required("records"),
  taskCount: required("task-count"),
  recordCount: required("record-count"),
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
  elements.tasks.replaceChildren(
    ...(tasks.length > 0
      ? tasks.map(({ task, logRoot }) => taskButton(task, logRoot, state.selectedTask?.id === task.id))
      : [empty(state.loading.tasks ? "正在加载任务…" : state.stale ? "任务数据可能已过期" : "没有匹配的任务")]),
  );

  const records = state.records?.records ?? [];
  elements.recordCount.textContent = state.records ? `${String(state.records.total)} 项` : "";
  elements.records.replaceChildren(
    ...(records.length > 0
      ? records.map((record) => recordButton(record, selectedRecordId === record.id))
      : [empty(state.loading.records ? "正在加载请求…" : state.selectedTask ? "该任务没有请求记录" : "请先选择任务")]),
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

function taskButton(task: TaskSummary, logRoot: string, active: boolean): HTMLButtonElement {
  const control = historyButton(active);
  control.append(
    text("history-title", `${task.model ?? task.kind} · ${task.endpoint}`),
    text(
      "history-meta",
      `${formatTime(task.lastSeenAt)} | ${String(task.requestCount)} 个请求 | ${task.pending ? "进行中" : (task.target ?? "未路由")}`,
    ),
  );
  control.addEventListener("click", () => {
    selectedRecordId = null;
    void controller.selectTask(logRoot, task.id);
  });
  return control;
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
    elements.requestDetail.textContent = "暂无请求内容";
    elements.responseDetail.textContent = "暂无响应内容";
    return;
  }
  elements.detailSummary.textContent = `${detail.method} ${detail.path} · ${String(detail.status ?? "未完成")} · ${formatDuration(detail.durationMs)} · ${detail.proxy.name} → ${detail.target.name}`;
  elements.requestMeta.textContent = `客户端 ${detail.client.host}:${String(detail.client.port)}\nHeaders\n${headersText(detail.request.headers)}`;
  elements.requestDetail.textContent = payloadText(detail.request.body);
  elements.responseMeta.textContent = detail.response
    ? `Headers\n${headersText(detail.response.headers)}`
    : "请求尚无响应";
  elements.responseDetail.textContent = detail.response ? payloadText(detail.response.body) : "暂无响应内容";
}

function payloadText(payload: CapturedPayload): string {
  const suffix = payload.truncated
    ? `\n\n[内容已截断：捕获 ${String(payload.capturedBytes)} / ${String(payload.observedBytes)} bytes]`
    : "";
  if (payload.kind === "empty") return `（空）${suffix}`;
  if (payload.kind === "json") return `${JSON.stringify(payload.value, null, 2)}${suffix}`;
  if (payload.kind === "text") return `${payload.text}${suffix}`;
  return `[二进制内容，Base64]\n${payload.base64}${suffix}`;
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
