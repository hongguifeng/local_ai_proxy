import { expect, test } from "@playwright/test";

test("admin workflows cover proxy, logs, cleanup, export and narrow screens", async ({ page }) => {
  expect((await page.request.get("/api/v1/proxies")).ok()).toBe(true);
  await page.goto("/");
  await expect(page.getByText("Fixture Proxy", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.getByText("gpt-page-48 · 1 请求", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "添加代理" }).click();
  const newName = page.getByLabel("新代理 名称");
  await newName.fill("Browser Proxy");
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByText("配置已保存", { exact: true })).toBeVisible();
  await expect(page.getByText("Browser Proxy", { exact: true })).toBeVisible();

  const toggle = page.locator("article.card").filter({ hasText: "Fixture Proxy" }).locator('input[type="checkbox"]');
  await toggle.uncheck();
  await expect(
    page.locator("article.card").filter({ hasText: "Fixture Proxy" }).getByText("configured", { exact: true }),
  ).toBeVisible();

  await page.getByPlaceholder("模型、路径、内容…").fill("gpt-sse");
  await page.getByRole("button", { name: "搜索" }).click();
  await page.getByText("gpt-sse · 1 请求", { exact: true }).click();
  await page.getByText("#1 POST 200", { exact: true }).click();
  await expect(page.locator("#detail")).toContainText("text/event-stream");

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
