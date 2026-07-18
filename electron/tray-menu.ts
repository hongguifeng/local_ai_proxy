export interface TrayMenuItem {
  readonly click: () => void;
  readonly label: string;
}

export interface TrayOpenActions<TMenu> {
  on(event: "click" | "double-click", listener: () => void): unknown;
  setContextMenu(menu: TMenu): unknown;
}

export function installOpenAdminActions<TMenu>(
  tray: TrayOpenActions<TMenu>,
  buildMenu: (template: readonly TrayMenuItem[]) => TMenu,
  openAdmin: () => void,
): void {
  tray.setContextMenu(
    buildMenu([
      {
        label: "Open Admin UI",
        click: openAdmin,
      },
    ]),
  );
  tray.on("click", openAdmin);
  tray.on("double-click", openAdmin);
}
