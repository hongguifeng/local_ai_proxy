"""整个代理项目共用的常量。

这个文件只放“不会随运行过程变化”的值。把常量集中放在这里，
可以避免多个模块里重复写字符串，也方便以后统一修改。
"""

from __future__ import annotations

HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}
"""不能直接转发给上游服务器的 HTTP 头。

这些头只描述“当前这一跳连接”的状态，例如连接是否保持、是否升级协议等。
代理收到客户端请求后，会重新和上游建立连接，所以这些头需要丢弃。
"""


DEFAULT_PORTS = {
    "http": 80,
    "https": 443,
}
"""不同协议的默认端口。解析目标地址时，如果用户没写端口，就使用这里的值。"""

DEFAULT_STRIP_REQUEST_FIELDS = (
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "typical_p",
    "repeat_penalty",
    "presence_penalty",
    "frequency_penalty",
    "seed",
)
"""默认从请求 JSON 中移除的采样参数。

这个代理常用于把同一个请求转发到固定的上游模型服务。移除这些随机性相关字段，
可以让上游更容易按自己的默认配置运行，也能减少不同客户端参数造成的干扰。
"""

