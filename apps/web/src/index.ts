import { ApiClient } from "./api-client.js";
import "./style.css";
import { AdminUiController, type UiState } from "./ui-controller.js";

const elements = {
  error: required("error"),
  proxies: required("proxies"),
  tasks: required("tasks"),
  records: required("records"),
  detail: required("detail"),
  export: required("export") as HTMLAnchorElement,
  cleanup: required("cleanup") as HTMLButtonElement,
  query: required("query") as HTMLInputElement,
};
const controller = new AdminUiController(new ApiClient(), render);

required("refresh").addEventListener("click", () => void refresh());
required("save-proxies").addEventListener("click", () => void controller.saveProxies());
required("task-search").addEventListener("submit", (event) => {
  event.preventDefault();
  void controller.searchTasks(elements.query.value);
});
elements.cleanup.addEventListener("click", () => void controller.cleanupSelected());
void refresh();

async function refresh(): Promise<void> {
  await Promise.all([controller.loadProxies(), controller.searchTasks(elements.query.value)]);
}

function render(state: UiState): void {
  elements.error.hidden = state.error === null;
  elements.error.textContent = state.error ?? "";
  elements.proxies.replaceChildren(...state.proxies.map(proxyCard));
  elements.tasks.replaceChildren(
    ...(state.tasks?.tasks ?? []).map(({ task, logRoot }) =>
      listButton(
        `${task.model ?? task.kind} · ${String(task.requestCount)} 请求`,
        () => void controller.selectTask(logRoot, task.id),
      ),
    ),
  );
  elements.records.replaceChildren(
    ...(state.records?.records ?? []).map((record) =>
      listButton(
        `#${String(record.sequence)} ${record.method} ${String(record.status ?? "…")}`,
        () => void controller.selectRecord(record.id),
      ),
    ),
  );
  elements.detail.textContent = state.detail ? JSON.stringify(state.detail, null, 2) : "选择一条请求查看详情";
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
  card.append(title, status, address, toggle);
  return card;
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
