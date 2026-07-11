# 故障注入与恢复矩阵

| 故障 | 预期 outcome | Health | 运行日志 | 恢复方式 | 自动化证据 |
| --- | --- | --- | --- | --- | --- |
| SQLite busy/locked | 写入有限等待或降级丢弃，数据库保持可恢复 | degraded | `SQLITE_BUSY` | 释放锁后恢复 | `fault-injection.test.ts` |
| Worker crash/restart 失败 | pending promise 失败，不挂死主线程 | degraded/failed | `STORAGE_RESTARTING` / exhausted | 有限指数退避 | `storage-worker.test.ts`, `runtime-recovery.test.ts` |
| 磁盘满/只读 | persistence 降级，代理继续 | degraded | `DISK_LOW_WATERMARK` / write failure | 清理或恢复可写容量 | `storage-capacity.test.ts`, `config-repository.test.ts` |
| config rename 失败 | 原文件保持完整 | ok | `CONFIG_WRITE_FAILED` | 重试原子替换 | `config-repository.test.ts` |
| socket/TLS/DNS | 返回安全 502/504 | ok | upstream error code | 后续请求重试 | `proxy-protocol-faults.test.ts`, `proxy-timeouts.test.ts` |
| shutdown 持续新连接 | 停止接收，宽限后 abort active | non-ready | `SERVER_SHUTDOWN` | 重启服务 | `proxy-protocol-faults.test.ts` |
| 日志队列持续过载 | 内存有界并计数 dropped | degraded | `STORAGE_QUEUE_FULL`（限频） | drain 后恢复 | `storage-write-queue.test.ts`, `logging.test.ts` |
