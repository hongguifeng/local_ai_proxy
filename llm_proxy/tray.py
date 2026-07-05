"""System tray launcher for the admin UI."""

from __future__ import annotations

import argparse
import os
import sys
import threading
import webbrowser
from pathlib import Path
from typing import Any

from .admin_server import AdminServer
from .manager import DEFAULT_CONFIG_PATH, DEFAULT_LOG_ROOT, ProxyManager


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the local LLM proxy admin UI in the system tray.")
    parser.add_argument("--host", default=os.getenv("LLM_PROXY_UI_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("LLM_PROXY_UI_PORT", "8088")))
    parser.add_argument("--config-file", default=os.getenv("LLM_PROXY_CONFIG_FILE", str(DEFAULT_CONFIG_PATH)))
    parser.add_argument("--log-root", default=os.getenv("LLM_PROXY_LOG_ROOT", str(DEFAULT_LOG_ROOT)))
    parser.add_argument("--open-on-start", action="store_true", default=os.getenv("LLM_PROXY_OPEN_ON_START") == "1")
    return parser.parse_args(argv)


class TrayApp:
    def __init__(
        self,
        host: str,
        port: int,
        config_file: Path,
        log_root: Path | None,
        *,
        open_on_start: bool = False,
    ) -> None:
        self.host = host
        self.port = port
        self.manager = ProxyManager(config_file, log_root=log_root)
        self.open_on_start = open_on_start
        self.ui_url = f"http://{host}:{port}"
        self.icon: Any | None = None
        self.server: AdminServer | None = None
        self.server_thread: threading.Thread | None = None
        self.shutdown_lock = threading.Lock()
        self.stopped = False

    def run(self) -> None:
        pystray, image_module, image_draw = load_tray_dependencies()
        menu = pystray.Menu(
            pystray.MenuItem("Open Admin UI", self.open_admin_ui, default=True),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Exit", self.exit_app),
        )
        self.icon = pystray.Icon("llm-proxy", create_icon_image(image_module, image_draw), "LLM Proxy", menu)
        self.start_server()
        try:
            self.icon.run(setup=self.on_ready)
        finally:
            self.stop_server()

    def start_server(self) -> None:
        self.server = AdminServer((self.host, self.port), self.manager)
        try:
            self.manager.start_enabled()
        except Exception:
            self.server.server_close()
            self.server = None
            self.manager.stop_all()
            raise
        self.server_thread = threading.Thread(
            target=self.server.serve_forever,
            daemon=True,
            name="llm-proxy-admin",
        )
        self.server_thread.start()

    def stop_server(self) -> None:
        with self.shutdown_lock:
            if self.stopped:
                return
            self.stopped = True
            server = self.server
            server_thread = self.server_thread
            self.server = None
            self.server_thread = None

        if server:
            server.shutdown()
            server.server_close()
        self.manager.stop_all()
        if server_thread and server_thread.is_alive():
            server_thread.join(timeout=2)

    def on_ready(self, icon: Any) -> None:
        icon.visible = True
        if self.open_on_start:
            self.open_admin_ui(icon)

    def open_admin_ui(self, _icon: Any = None, _item: Any = None) -> None:
        webbrowser.open(self.ui_url)

    def exit_app(self, icon: Any = None, _item: Any = None) -> None:
        threading.Thread(target=self._exit_from_background, args=(icon,), daemon=True).start()

    def _exit_from_background(self, icon: Any = None) -> None:
        self.stop_server()
        active_icon = icon or self.icon
        if active_icon:
            active_icon.stop()


def load_tray_dependencies() -> tuple[Any, Any, Any]:
    try:
        import pystray
        from PIL import Image, ImageDraw
    except ImportError as exc:
        raise RuntimeError(
            "Tray mode requires pystray and Pillow. Install them with: python -m pip install -e .[tray]"
        ) from exc
    return pystray, Image, ImageDraw


def create_icon_image(image_module: Any, image_draw: Any) -> Any:
    image = image_module.new("RGBA", (64, 64), (0, 0, 0, 0))
    draw = image_draw.Draw(image)
    draw.rounded_rectangle((8, 8, 56, 56), radius=12, fill=(37, 99, 235, 255))
    draw.rounded_rectangle((18, 18, 46, 46), radius=5, outline=(255, 255, 255, 255), width=5)
    draw.rectangle((28, 16, 36, 48), fill=(37, 99, 235, 255))
    draw.line((20, 44, 44, 20), fill=(255, 255, 255, 255), width=5)
    return image


def show_error(message: str) -> None:
    if sys.platform == "win32":
        import ctypes

        ctypes.windll.user32.MessageBoxW(None, message, "LLM Proxy", 0x10)
        return
    print(message, file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        log_root = Path(args.log_root) if args.log_root else None
        app = TrayApp(
            args.host,
            args.port,
            Path(args.config_file),
            log_root,
            open_on_start=bool(args.open_on_start),
        )
        app.run()
    except Exception as exc:
        show_error(f"LLM Proxy failed to start:\n{exc}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
