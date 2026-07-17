export interface ParsedSseEvents {
  readonly events: readonly unknown[];
  readonly doneSeen: boolean;
}

export function parseSseEvents(text: string): ParsedSseEvents | undefined {
  const events: unknown[] = [];
  let doneSeen = false;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) {
      continue;
    }
    const data = line.slice(5).trim();
    if (data === "") {
      continue;
    }
    if (data === "[DONE]") {
      doneSeen = true;
      continue;
    }
    try {
      events.push(JSON.parse(data) as unknown);
    } catch {
      return undefined;
    }
  }
  return events.length === 0 ? undefined : { events, doneSeen };
}
