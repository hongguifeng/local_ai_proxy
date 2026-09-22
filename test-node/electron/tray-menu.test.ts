import { describe, expect, it, vi } from "vitest";

import { installOpenAdminActions, type TrayMenuItem } from "../../electron/tray-menu.js";

interface MenuModel {
  readonly template: readonly TrayMenuItem[];
}

function makeTray() {
  const listeners = new Map<string, () => void>();
  const setContextMenu = vi.fn();
  const tray = {
    setContextMenu,
    on: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener);
      return tray;
    }),
  };
  return { listeners, setContextMenu, tray };
}

describe("installOpenAdminActions", () => {
  it("opens the admin UI from the menu and tray default actions", () => {
    const { listeners, setContextMenu, tray } = makeTray();
    const openAdmin = vi.fn();
    const exit = vi.fn(() => Promise.resolve());
    const buildMenu = vi.fn((template: readonly TrayMenuItem[]): MenuModel => ({ template }));

    installOpenAdminActions(tray, buildMenu, openAdmin, exit);
    const template = buildMenu.mock.calls[0]?.[0] ?? [];
    const openItem = template[0];
    const exitItem = template[2];
    if (openItem !== undefined && "click" in openItem) openItem.click();
    if (exitItem !== undefined && "click" in exitItem) exitItem.click();
    listeners.get("click")?.();
    listeners.get("double-click")?.();

    expect(openAdmin).toHaveBeenCalledTimes(3);
    expect(exit).toHaveBeenCalledOnce();
    expect(setContextMenu).toHaveBeenCalledOnce();
  });

  it("renders the auto start toggle as a checkbox and rebuilds after toggling", async () => {
    const { setContextMenu, tray } = makeTray();
    const openAdmin = vi.fn();
    const exit = vi.fn(() => Promise.resolve());
    const buildMenu = vi.fn((template: readonly TrayMenuItem[]): MenuModel => ({ template }));
    let autoStart = true;
    const toggle = vi.fn(() => {
      autoStart = !autoStart;
      return Promise.resolve();
    });
    const control = {
      state: {
        get autoStart() {
          return autoStart;
        },
      },
      toggle,
    };

    installOpenAdminActions(tray, buildMenu, openAdmin, exit, control);
    const first = buildMenu.mock.calls[0]?.[0] ?? [];
    const firstToggle = first[2];
    // When enabled, the label carries a check mark (Windows ignores "checked").
    expect(firstToggle).toMatchObject({
      checked: true,
      label: "\u2713 Start with Windows",
      type: "checkbox",
    });

    if (firstToggle !== undefined && "click" in firstToggle) firstToggle.click();
    await vi.waitFor(() => expect(toggle).toHaveBeenCalledOnce());

    const second = buildMenu.mock.calls[1]?.[0] ?? [];
    const secondToggle = second[2];
    // When disabled, the label carries a hollow dot.
    expect(secondToggle).toMatchObject({
      checked: false,
      label: "\u00B7 Start with Windows",
      type: "checkbox",
    });
    expect(setContextMenu).toHaveBeenCalledTimes(2);
    expect(exit).not.toHaveBeenCalled();
  });

  it("omits the auto start item when no control is provided", () => {
    const { setContextMenu, tray } = makeTray();
    const buildMenu = vi.fn((template: readonly TrayMenuItem[]): MenuModel => ({ template }));

    installOpenAdminActions(
      tray,
      buildMenu,
      vi.fn(),
      vi.fn(() => Promise.resolve()),
    );
    const template = buildMenu.mock.calls[0]?.[0] ?? [];

    expect(template).toHaveLength(3);
    expect(template.map((item) => ("type" in item ? item.type : "item"))).toEqual([
      "item",
      "separator",
      "item",
    ]);
    expect(setContextMenu).toHaveBeenCalledOnce();
  });
});
