const ISO_MILLISECONDS_LENGTH = 3;

export function localNowIso(): string {
  return formatLocalIso(new Date());
}

export function formatLocalIso(value: Date): string {
  const year = value.getFullYear();
  const month = pad(value.getMonth() + 1, 2);
  const day = pad(value.getDate(), 2);
  const hours = pad(value.getHours(), 2);
  const minutes = pad(value.getMinutes(), 2);
  const seconds = pad(value.getSeconds(), 2);
  const milliseconds = pad(value.getMilliseconds(), ISO_MILLISECONDS_LENGTH);
  const offsetMinutes = -value.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = pad(Math.floor(absoluteOffset / 60), 2);
  const offsetRemainder = pad(absoluteOffset % 60, 2);
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}${offsetSign}${offsetHours}:${offsetRemainder}`;
}

export function formatLocalTimestamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid timestamp: ${String(value)}`);
  }
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`,
    `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}`,
  ].join(" ");
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, "0");
}
