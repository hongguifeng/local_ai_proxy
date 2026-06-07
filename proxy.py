#!/usr/bin/env python3
"""旧入口兼容文件。

现在项目主体已经移动到 ``llm_proxy`` 包中。保留这个文件是为了让旧用法
``python proxy.py`` 和 ``from proxy import ...`` 继续可用。

新脚本更推荐使用 ``python -m llm_proxy``。
"""

from __future__ import annotations

from llm_proxy import *  # noqa: F403 - 保留历史顶层 API，方便旧代码继续导入。
from llm_proxy.cli import main


if __name__ == "__main__":
    # 直接运行 proxy.py 时，进入新的包入口。
    raise SystemExit(main())
