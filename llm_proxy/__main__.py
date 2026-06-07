"""支持 ``python -m llm_proxy`` 的入口文件。"""

from __future__ import annotations

from .cli import main

if __name__ == "__main__":
    # main() 返回进程退出码，SystemExit 会把它交给操作系统。
    raise SystemExit(main())
