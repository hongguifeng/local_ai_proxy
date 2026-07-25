import type { Application } from "../app/index.js";

export interface SignalProcess {
  off(event: NodeJS.Signals, listener: () => void): unknown;
  on(event: NodeJS.Signals, listener: () => void): unknown;
}

export function installShutdownSignals(
  application: Application,
  signalProcess: SignalProcess = process,
  onError: (error: unknown) => void = console.error,
): () => void {
  // SIGINT 通常来自 Ctrl+C，SIGTERM 通常来自服务管理器或容器停止命令。
  // stopping 防止短时间内收到多个信号时重复关闭同一批资源。
  let stopping = false;
  const listeners = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const listener = () => {
      if (stopping) return;
      stopping = true;
      // 事件监听器不能直接 await，所以用 void 明确表示这里有意启动异步关闭流程。
      void application.stop().catch(onError).finally(remove);
    };
    listeners.set(signal, listener);
    signalProcess.on(signal, listener);
  }
  function remove(): void {
    for (const [signal, listener] of listeners) signalProcess.off(signal, listener);
    listeners.clear();
  }
  return remove;
}
