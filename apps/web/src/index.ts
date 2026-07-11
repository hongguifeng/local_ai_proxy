import { ApiClient } from "./api-client.js";
import "./style.css";
import { AdminUiController, type UiState } from "./ui-controller.js";

const elements = {
  error: required("error"),
  notice: required("notice"),
  proxies: required("proxies"),
  tasks: required("tasks"),
  records: required("records"),
  detail: required("detail"),
  export: required("export") as HTMLAnchorElement,
  cleanup: required("cleanup") as HTMLButtonElement,
  save: required("save-proxies") as HTMLButtonElement,
  tasksPrev: required("tasks-prev") as HTMLButtonElement,
  tasksNext: required("tasks-next") as HTMLButtonElement,
  query: required("query") as HTMLInputElement,
};
const controller = new AdminUiController(new ApiClient(), render);

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
  void controller.searchTasks(elements.query.value);
});
elements.cleanup.addEventListener("click", () => {
  if (window.confirm("确定要永久清理所选任务及其请求记录吗？")) void controller.cleanupSelected();
});
void refresh();

async function refresh(): Promise<void> {
  await Promise.all([controller.loadProxies(), controller.searchTasks(elements.query.value)]);
}

function render(state: UiState): void {
  elements.error.hidden = state.error === null;
  elements.error.textContent = state.error ?? "";
  elements.notice.hidden = state.notice === null;
  elements.notice.textContent = state.notice ?? "";
  elements.save.disabled = state.loading.mutation;
  elements.tasksPrev.disabled = state.loading.tasks || !state.tasks || state.tasks.offset === 0;
  elements.tasksNext.disabled = state.loading.tasks || !state.tasks?.hasMore;
  elements.proxies.replaceChildren(...state.proxies.map(proxyCard));
  const taskButtons = (state.tasks?.tasks ?? []).map(({ task, logRoot }) =>
    listButton(
      `${task.model ?? task.kind} · ${String(task.requestCount)} 请求`,
      () => void controller.selectTask(logRoot, task.id),
    ),
  );
  elements.tasks.replaceChildren(
    ...(taskButtons.length > 0
      ? taskButtons
      : [message(state.loading.tasks ? "正在加载任务…" : state.stale ? "任务数据可能已过期" : "没有匹配的任务")]),
  );
  const recordButtons = (state.records?.records ?? []).map((record) =>
    listButton(
      `#${String(record.sequence)} ${record.method} ${String(record.status ?? "…")}`,
      () => void controller.selectRecord(record.id),
    ),
  );
  elements.records.replaceChildren(
    ...(recordButtons.length > 0
      ? recordButtons
      : [
          message(state.loading.records ? "正在加载请求…" : state.selectedTask ? "该任务没有请求记录" : "请先选择任务"),
        ]),
  );
  elements.detail.textContent = state.loading.detail
    ? "正在加载详情…"
    : state.detail
      ? JSON.stringify(state.detail, null, 2)
      : "选择一条请求查看详情";
  const exportUrl = controller.exportUrl(elements.query.value);
  elements.export.hidden = exportUrl === null;
  if (exportUrl) elements.export.href = exportUrl;
  elements.cleanup.disabled = state.selectedTask === null || state.loading.mutation;
}

function proxyCard(proxy: UiState["proxies"][number]): HTMLElement {
  const card = document.createElement("article");
  card.className = "card";
  const title = document.createElement("strong");
  title.textContent = proxy.name;
  const status = document.createElement("span");
  status.className = `status ${proxy.runtime.state}`;
  status.textContent = proxy.runtime.state;
  const address = document.createElement("small");
  address.textContent = `${proxy.listenHost}:${String(proxy.runtime.actualListenPort ?? proxy.listenPort)}`;
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = proxy.enabled;
  toggle.addEventListener("change", () => void controller.toggleProxy(proxy.id, toggle.checked));
  const name = document.createElement("input");
  name.value = proxy.name;
  name.setAttribute("aria-label", `${proxy.name} 名称`);
  name.addEventListener("input", () => {
    controller.updateProxy(proxy.id, { name: name.value });
  });
  const port = document.createElement("input");
  port.type = "number";
  port.min = "0";
  port.max = "65535";
  port.value = String(proxy.listenPort);
  port.setAttribute("aria-label", `${proxy.name} 端口`);
  port.addEventListener("input", () => {
    controller.updateProxy(proxy.id, { listenPort: Number(port.value) });
  });
  card.append(title, status, address, toggle, name, port);
  for (const target of proxy.targets) {
    const secret = document.createElement("div");
    secret.className = "secret";
    const label = document.createElement("span");
    label.textContent = `${target.name} API key：${target.apiKey.configured ? (target.apiKey.masked ?? "已配置") : "未配置"}`;
    const action = document.createElement("select");
    for (const [value, text] of [
      ["keep", "保持"],
      ["replace", "替换"],
      ["clear", "清除"],
    ] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      action.append(option);
    }
    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "new-password";
    input.placeholder = "输入新的 API key";
    input.hidden = true;
    const update = () => {
      input.hidden = action.value !== "replace";
      controller.setTargetSecret(proxy.id, target.id, action.value as "keep" | "replace" | "clear", input.value);
    };
    action.addEventListener("change", update);
    input.addEventListener("input", update);
    secret.append(label, action, input);
    card.append(secret);
  }
  return card;
}

function message(text: string): HTMLElement {
  const element = document.createElement("p");
  element.className = "message";
  element.textContent = text;
  return element;
}

function listButton(text: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.addEventListener("click", action);
  return button;
}

function required(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element: ${id}`);
  return element;
}
