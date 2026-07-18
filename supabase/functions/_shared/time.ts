import { readOptionalEnv } from "./env.ts";

const timezone = readOptionalEnv("TIMEZONE", "Europe/Moscow")!;

function partsFor(date: Date): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(date);
}

function partValue(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find((part) => part.type === type)?.value ?? "";
}

export function getConfiguredTimezone(): string {
  return timezone;
}

export function getLocalDateString(date = new Date()): string {
  const parts = partsFor(date);
  return `${partValue(parts, "year")}-${partValue(parts, "month")}-${partValue(parts, "day")}`;
}

export function getLocalDateTimeLabel(date = new Date()): string {
  const parts = partsFor(date);
  return `${partValue(parts, "year")}-${partValue(parts, "month")}-${partValue(parts, "day")} ${partValue(parts, "hour")}:${partValue(parts, "minute")}`;
}

export function minutesSince(isoDate?: string | null, now = new Date()): number | null {
  if (!isoDate) {
    return null;
  }

  const value = new Date(isoDate).getTime();
  if (Number.isNaN(value)) {
    return null;
  }

  return Math.floor((now.getTime() - value) / 60000);
}

export function getWeekStartDateString(date = new Date()): string {
  const localDate = getLocalDateString(date);
  const [year, month, day] = localDate.split("-").map(Number);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = utcDate.getUTCDay();
  const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  utcDate.setUTCDate(utcDate.getUTCDate() + diff);
  return utcDate.toISOString().slice(0, 10);
}
