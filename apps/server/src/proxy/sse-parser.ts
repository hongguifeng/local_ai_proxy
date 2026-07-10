export type SseEvent = Readonly<{
  event: string;
  id: string | null;
  data: string;
  done: boolean;
}>;

export type SseParserDiagnosticCode = "invalid_utf8" | "line_too_large" | "event_too_large" | "buffer_too_large";

export type SseParserDiagnostic = Readonly<{
  code: SseParserDiagnosticCode;
  message: string;
}>;

export type SseParserOutput = Readonly<{
  events: readonly SseEvent[];
  diagnostics: readonly SseParserDiagnostic[];
}>;

export type SseParserLimits = Readonly<{
  maxLineChars: number;
  maxEventChars: number;
  maxBufferChars: number;
  maxDiagnostics: number;
}>;

export const DEFAULT_SSE_PARSER_LIMITS: SseParserLimits = Object.freeze({
  maxLineChars: 64 * 1024,
  maxEventChars: 1024 * 1024,
  maxBufferChars: 2 * 1024 * 1024,
  maxDiagnostics: 100,
});

export class SseParser {
  readonly #limits: SseParserLimits;
  #decoder = new TextDecoder("utf-8", { fatal: true });
  #line = "";
  #dataLines: string[] = [];
  #dataChars = 0;
  #eventName = "message";
  #lastEventId: string | null = null;
  #discardLine = false;
  #discardEvent = false;
  #diagnosticsEmitted = 0;

  public constructor(limits: SseParserLimits = DEFAULT_SSE_PARSER_LIMITS) {
    assertLimits(limits);
    this.#limits = limits;
  }

  public push(chunk: Uint8Array): SseParserOutput {
    let text: string;
    const diagnostics: SseParserDiagnostic[] = [];
    try {
      text = this.#decoder.decode(chunk, { stream: true });
    } catch {
      this.#warn(diagnostics, "invalid_utf8", "SSE stream contained invalid UTF-8");
      this.#decoder = new TextDecoder("utf-8", { fatal: true });
      text = new TextDecoder().decode(chunk);
    }
    return this.#consume(text, diagnostics);
  }

  public finish(): SseParserOutput {
    const diagnostics: SseParserDiagnostic[] = [];
    let tail = "";
    try {
      tail = this.#decoder.decode();
    } catch {
      this.#warn(diagnostics, "invalid_utf8", "SSE stream ended with incomplete UTF-8");
    }
    const output = this.#consume(tail, diagnostics);
    const events = [...output.events];
    if (this.#line || this.#discardLine) this.#completeLine(events, diagnostics);
    this.#dispatch(events);
    return { events, diagnostics };
  }

  #consume(text: string, diagnostics: SseParserDiagnostic[]): SseParserOutput {
    const events: SseEvent[] = [];
    for (const character of text) {
      if (character === "\n") {
        this.#completeLine(events, diagnostics);
        continue;
      }
      if (this.#discardLine) continue;
      this.#line += character;
      if (this.#line.length > this.#limits.maxLineChars) {
        this.#line = "";
        this.#discardLine = true;
        this.#discardEvent = true;
        this.#warn(diagnostics, "line_too_large", "SSE line exceeded the configured limit");
      } else if (this.#bufferedChars() > this.#limits.maxBufferChars) {
        this.#resetEvent();
        this.#discardLine = true;
        this.#discardEvent = true;
        this.#warn(diagnostics, "buffer_too_large", "SSE parser buffer exceeded the configured limit");
      }
    }
    return { events, diagnostics };
  }

  #completeLine(events: SseEvent[], diagnostics: SseParserDiagnostic[]): void {
    if (this.#discardLine) {
      this.#discardLine = false;
      this.#line = "";
      return;
    }
    const line = this.#line.endsWith("\r") ? this.#line.slice(0, -1) : this.#line;
    this.#line = "";
    if (line === "") {
      if (!this.#discardEvent) this.#dispatch(events);
      this.#resetEvent();
      return;
    }
    if (this.#discardEvent || line.startsWith(":")) return;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      this.#eventName = value || "message";
    } else if (field === "id") {
      if (!value.includes("\0")) this.#lastEventId = value;
    } else if (field === "data") {
      const nextSize = this.#dataChars + value.length + 1;
      if (nextSize > this.#limits.maxEventChars) {
        this.#discardEvent = true;
        this.#dataLines = [];
        this.#dataChars = 0;
        this.#warn(diagnostics, "event_too_large", "SSE event data exceeded the configured limit");
      } else {
        this.#dataLines.push(value);
        this.#dataChars = nextSize;
      }
    }
  }

  #dispatch(events: SseEvent[]): void {
    if (this.#dataLines.length === 0) return;
    const data = this.#dataLines.join("\n");
    events.push({ event: this.#eventName, id: this.#lastEventId, data, done: data.trim() === "[DONE]" });
    this.#dataLines = [];
    this.#dataChars = 0;
    this.#eventName = "message";
  }

  #resetEvent(): void {
    this.#dataLines = [];
    this.#dataChars = 0;
    this.#eventName = "message";
    this.#discardEvent = false;
  }

  #bufferedChars(): number {
    return this.#line.length + this.#dataChars;
  }

  #warn(diagnostics: SseParserDiagnostic[], code: SseParserDiagnosticCode, message: string): void {
    if (this.#diagnosticsEmitted >= this.#limits.maxDiagnostics) return;
    this.#diagnosticsEmitted += 1;
    diagnostics.push({ code, message });
  }
}

function assertLimits(limits: SseParserLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  }
  if (limits.maxBufferChars < limits.maxLineChars) {
    throw new RangeError("maxBufferChars must be greater than or equal to maxLineChars");
  }
}
