import * as chrono from "chrono-node";
import type {
  AvailabilityPreference,
  AvailabilityTimePreference,
} from "../clients/owned-middleware.js";

const CLINIC_TIME_ZONE = "America/New_York";

export interface SchedulingClock {
  now(): Date;
}

export type AvailabilityWhenResolution = {
  date: string;
  preferences?: AvailabilityPreference[];
};

export const systemSchedulingClock: SchedulingClock = {
  now: () => new Date(),
};

export function resolveAvailabilityWhen(
  when: string,
  clock: SchedulingClock,
  currentAvailabilityDate?: string,
): AvailabilityWhenResolution {
  const now = clock.now();
  const earliestDate = addIsoDays(clinicIsoDate(now), 1);
  const parsed = parseCallerPhrase(when, now);
  let preference = callerPreference(parsed, earliestDate);
  const currentDateReference = refersToCurrentAvailabilityDate(when);
  if (currentDateReference && currentAvailabilityDate && !preference?.date) {
    const date = clampDate(currentAvailabilityDate, earliestDate);
    preference = preference ? { ...preference, date } : { date };
  }

  return {
    date: preference?.date ?? earliestDate,
    ...(preference ? { preferences: [preference] } : {}),
  };
}

function refersToCurrentAvailabilityDate(when: string): boolean {
  const normalized = when.toLocaleLowerCase("en-US");
  return (
    normalized.includes("that day") ||
    normalized.includes("same day") ||
    normalized.includes("ese día")
  );
}

export function clinicTimestampMessage(now: Date): string {
  const date = clinicIsoDate(now);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: CLINIC_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(now);
  return (
    `Current clinic-local date and time for this turn: ${spokenClinicDate(date)} at ${time} Eastern time. ` +
    "Scheduling tools resolve caller date language independently when called."
  );
}

function parseCallerPhrase(when: string, now: Date): chrono.ParsedResult[] {
  // Give Chrono the clinic wall clock at UTC so parsing is independent of the
  // container timezone while keeping relative calendar components intact.
  const reference = { instant: clinicReferenceDate(now), timezone: 0 };
  const options = { forwardDate: true };
  const original = [
    ...chrono.en.parse(when, reference, options),
    ...chrono.es.parse(when, reference, options),
  ].sort((left, right) => left.index - right.index)[0];
  if (!original) {
    const clock = parseTrailingClock(when, 0, reference, options);
    return clock ? [clock] : [];
  }

  const parsedThrough = original.index + original.text.length;
  const trailing = when.slice(parsedThrough);
  const clock = startsWithClockConnector(trailing)
    ? parseTrailingClock(trailing, parsedThrough, reference, options)
    : undefined;
  return clock ? [original, clock] : [original];
}

function parseTrailingClock(
  when: string,
  offset: number,
  reference: chrono.ParsingReference,
  options: chrono.ParsingOption,
): chrono.ParsedResult | undefined {
  const words = when.trim().split(" ").filter(Boolean);
  for (let index = 0; index < words.length; index += 1) {
    const candidate = `${" ".repeat(offset)}at ${words.slice(index).join(" ")}`;
    const parsed = [
      ...chrono.en.parse(candidate, reference, options),
      ...chrono.es.parse(candidate, reference, options),
    ].filter(hasTime);
    if (parsed[0]) return parsed[0];
  }
  return undefined;
}

function startsWithClockConnector(value: string): boolean {
  const firstWord = value.trim().split(" ").find(Boolean)?.toLowerCase();
  return (
    firstWord === "at" ||
    firstWord === "around" ||
    firstWord === "near" ||
    firstWord === "before" ||
    firstWord === "after" ||
    firstWord === "a" ||
    firstWord === "antes" ||
    firstWord === "después" ||
    firstWord === "alrededor"
  );
}

function hasDate(result: chrono.ParsedResult): boolean {
  return (
    result.start.isCertain("year") ||
    result.start.isCertain("month") ||
    result.start.isCertain("day") ||
    result.start.isCertain("weekday")
  );
}

function hasTime(result: chrono.ParsedResult): boolean {
  return result.start.isCertain("hour");
}

function componentIsoDate(result: chrono.ParsedResult): string {
  return isoDate(
    requiredComponent(result, "year"),
    requiredComponent(result, "month"),
    requiredComponent(result, "day"),
  );
}

function requiredComponent(
  result: chrono.ParsedResult,
  component: "year" | "month" | "day",
): number {
  const value = result.start.get(component);
  if (value === null) {
    throw new Error(`Chrono omitted ${component} from a parsed calendar date.`);
  }
  return value;
}

function daypartPreference(
  result: chrono.ParsedResult,
): AvailabilityTimePreference | undefined {
  const tags = result.tags();
  if (tags.has("casualReference/morning")) return { kind: "morning" };
  if (tags.has("casualReference/afternoon")) return { kind: "afternoon" };
  return undefined;
}

function clockTimePreference(
  result: chrono.ParsedResult,
): AvailabilityTimePreference | undefined {
  const hour = result.start.get("hour");
  if (hour === null) return undefined;
  const minute = result.start.get("minute") ?? 0;
  if (
    result.start.isCertain("meridiem") ||
    hour > 12 ||
    result.tags().has("casualReference/noon") ||
    result.tags().has("casualReference/midnight")
  ) {
    return { minuteOfDay: normalizedMinuteOfDay(hour, minute) };
  }

  return {
    minuteOfDay: normalizedMinuteOfDay(businessHoursHour(hour), minute),
  };
}

function businessHoursHour(hour: number): number {
  if (hour >= 1 && hour <= 6) return hour + 12;
  return hour === 12 ? 12 : hour;
}

function callerPreference(
  results: chrono.ParsedResult[],
  earliestDate: string,
): AvailabilityPreference | undefined {
  const primary = results[0];
  if (!primary) return undefined;

  const date = hasDate(primary) ? futureDate(primary, earliestDate) : undefined;
  const timeResult =
    daypartPreference(primary) || hasTime(primary) ? primary : results[1];
  const time = timeResult
    ? (daypartPreference(timeResult) ?? clockTimePreference(timeResult))
    : undefined;
  if (!date && !time) return undefined;
  return { ...(date ? { date } : {}), ...(time ? { time } : {}) };
}

function clinicReferenceDate(instant: Date): Date {
  const parts = clinicParts(instant, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return new Date(
    Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    ),
  );
}

function clinicIsoDate(instant: Date): string {
  const parts = clinicParts(instant, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function clinicParts(
  instant: Date,
  options: Intl.DateTimeFormatOptions,
): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CLINIC_TIME_ZONE,
    ...options,
  }).formatToParts(instant);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function spokenClinicDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: "UTC",
  }).format(date);
  const month = new Intl.DateTimeFormat("en-US", {
    month: "long",
    timeZone: "UTC",
  }).format(date);
  const day = date.getUTCDate();
  return `${weekday}, ${month} ${day}${ordinalSuffix(day)}, ${date.getUTCFullYear()}`;
}

function ordinalSuffix(day: number): string {
  const lastTwoDigits = day % 100;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 13) return "th";
  if (day % 10 === 1) return "st";
  if (day % 10 === 2) return "nd";
  if (day % 10 === 3) return "rd";
  return "th";
}

function isoDate(year: number, month: number, day: number): string {
  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-");
}

function addIsoDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function clampDate(value: string, earliestDate: string): string {
  return value < earliestDate ? earliestDate : value;
}

function futureDate(result: chrono.ParsedResult, earliestDate: string): string {
  const value = componentIsoDate(result);
  if (result.start.isCertain("weekday") && value < earliestDate) {
    return addIsoDays(value, 7);
  }
  return clampDate(value, earliestDate);
}

function normalizedMinuteOfDay(hour: number, minute: number): number {
  return (hour % 24) * 60 + minute;
}
