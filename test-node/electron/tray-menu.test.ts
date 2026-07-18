import { describe, expect, it, vi } from "vitest";

import { installOpenAdminActions } from "../../electron/tray-menu.js";

interface MenuModel {
  readonly template: readonly { readonly click: () => void; readonly label: string }[];
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
    const buildMenu = vi.fn((template: MenuModel["template"]): MenuModel => ({ template }));

    installOpenAdminActions(tray, buildMenu, openAdmin);
    buildMenu.mock.calls[0]?.[0][0]?.click();
    listeners.get("click")?.();
    listeners.get("double-click")?.();

    expect(openAdmin).toHaveBeenCalledTimes(3);
    expect(setContextMenu).toHaveBeenCalledOnce();
  });
});
