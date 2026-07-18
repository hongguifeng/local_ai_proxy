import { describe, expect, it, vi } from "vitest";

import { installOpenAdminActions } from "../../electron/tray-menu.js";

interface MenuModel {
  readonly template: readonly (
    { readonly click: () => void; readonly label: string } | { readonly type: "separator" }
  )[];
}

describe("installOpenAdminActions", () => {
  it("opens the admin UI from the menu and tray default actions", () => {
    const listeners = new Map<string, () => void>();
    const setContextMenu = vi.fn();
    const tray = {
      setContextMenu,
      on: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener);
        return tray;
      }),
    };
    const openAdmin = vi.fn();
    const exit = vi.fn(() => Promise.resolve());
    const buildMenu = vi.fn((template: MenuModel["template"]): MenuModel => ({ template }));

    installOpenAdminActions(tray, buildMenu, openAdmin, exit);
    const template = buildMenu.mock.calls[0]?.[0];
    const openItem = template?.[0];
    const exitItem = template?.[2];
    if (openItem !== undefined && "click" in openItem) openItem.click();
    if (exitItem !== undefined && "click" in exitItem) exitItem.click();
    listeners.get("click")?.();
    listeners.get("double-click")?.();

    expect(openAdmin).toHaveBeenCalledTimes(3);
    expect(exit).toHaveBeenCalledOnce();
    expect(setContextMenu).toHaveBeenCalledOnce();
  });
});
