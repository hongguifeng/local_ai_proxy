import { expect, test } from "@playwright/test";

test("admin workflows cover proxy, logs, cleanup, export and narrow screens", async ({ page }) => {
  expect((await page.request.get("/api/v1/proxies")).ok()).toBe(true);
  await page.goto("/");
  const fixtureCard = page.locator('[data-proxy-id="proxy-1"]');
  await expect(fixtureCard.getByLabel("代理名称")).toHaveValue("Fixture Proxy");
  await expect(fixtureCard.getByLabel("模型映射（每行 监听模型 => 上游模型）")).toBeVisible();
  await expect(fixtureCard.getByRole("checkbox", { name: "启用目标" })).toBeDisabled();
  await expect(fixtureCard.getByRole("button", { name: "设置" })).toHaveCount(1);
  await fixtureCard.getByRole("button", { name: "＋ 添加转发目标" }).click();
  const fixtureTargets = fixtureCard.locator(".target-card");
  await expect(fixtureTargets).toHaveCount(2);
  await fixtureTargets.nth(0).locator("summary").click();
  const targetHeights = await fixtureTargets.evaluateAll((targets) =>
    targets.map((target) => target.getBoundingClientRect().height),
  );
  expect(targetHeights[0]).toBeGreaterThan(targetHeights[1] ?? 0);
  await page.getByRole("button", { name: "历史记录" }).click();
  const treeDimensions = await page.locator("#history-tree").evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(treeDimensions.scrollHeight).toBeGreaterThan(treeDimensions.clientHeight);
  const sidebar = page.locator(".history-sidebar");
  const splitter = page.locator("#history-splitter");
  const originalWidth = await sidebar.evaluate((element) => element.getBoundingClientRect().width);
  const splitterBox = await splitter.boundingBox();
  if (!splitterBox) throw new Error("History splitter is not visible");
  await page.mouse.move(splitterBox.x + splitterBox.width / 2, splitterBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(splitterBox.x + 80, splitterBox.y + 40);
  await page.mouse.up();
  expect(await sidebar.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(originalWidth);
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.locator(".history-group-head").filter({ hasText: "gpt-page-48" })).toBeVisible();
  await page.getByRole("button", { name: "监听转发" }).click();
  const proxyCount = await page.getByLabel("代理名称").count();
  await page.getByRole("button", { name: "＋ 添加代理" }).click();
  const proxyNames = page.getByLabel("代理名称");
  await expect(proxyNames).toHaveCount(proxyCount + 1);
  const newName = proxyNames.nth(proxyCount);
  await newName.fill("Browser Proxy");
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByText("配置已保存", { exact: true })).toBeVisible();
  expect(
    await page.getByLabel("代理名称").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
  ).toContain("Browser Proxy");

  const toggle = fixtureCard.getByRole("checkbox", { name: "启用监听" });
  await toggle.uncheck();
  await expect(fixtureCard).toContainText("configured");

  await page.getByRole("button", { name: "历史记录" }).click();
  await page.getByPlaceholder("搜索模型、路径、内容或 ID").fill("gpt-sse");
  await page.getByRole("button", { name: "搜索" }).click();
  await page.locator(".history-group-head").filter({ hasText: "gpt-sse" }).click();
  await page.getByText("POST /v1/responses", { exact: true }).click();
  await expect(page.locator("#response-meta")).toContainText("text/event-stream");
  await expect(page.locator("#request-detail")).toContainText("hello from fixture");
  await expect(page.locator("#response-detail")).toContainText("fixture response");

  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "导出 ZIP" }).click();
  await download;
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "清理任务" }).click();
  await expect(page.getByText("任务已清理", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "刷新" })).toBeVisible();
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
});
