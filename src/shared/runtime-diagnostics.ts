const DEFAULT_STACK_TRACE_LIMIT = 50;

export function enableRuntimeDiagnostics(): void {
  process.setSourceMapsEnabled(true);
  Error.stackTraceLimit = DEFAULT_STACK_TRACE_LIMIT;
}
