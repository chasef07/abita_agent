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
  fallbackDate?: string,
): AvailabilityWhenResolution {
  const now = clock.now();
  const earliestDate = addIsoDays(clinicIsoDate(now), 1);
  const parsed = parseCallerPhrase(when, now);
  let preferences = callerPreferences(parsed, earliestDate);
  if (
    fallbackDate &&
    refersToCurrentAvailabilityDate(when) &&
    !preferences.some((preference) => preference.date) &&
    preferences.some((preference) => preference.time)
  ) {
    const date = clampDate(fallbackDate, earliestDate);
    preferences = preferences.map((preference) => ({
      ...preference,
      date,
    }));
  }
  const dates = distinct(
    preferences.flatMap((preference) =>
      preference.date ? [preference.date] : [],
    ),
  );

  return {
    date: dates.length > 0 ? minIsoDate(dates) : earliestDate,
    ...(preferences.length > 0 ? { preferences } : {}),
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
  const originalResults = [
    ...chrono.en.parse(when, reference, options),
    ...chrono.es.parse(when, reference, options),
  ];
  const results = [...originalResults];
  const parsedThrough = originalResults.reduce(
    (end, result) => Math.max(end, result.index + result.text.length),
    0,
  );
  const trailing = when.slice(parsedThrough);
  if (originalResults.length === 0 || startsWithClockConnector(trailing)) {
    results.push(
      ...parseTrailingClock(trailing, parsedThrough, reference, options),
    );
  }
  const seen = new Set<string>();
  const distinctResults = results.filter((result) => {
    const key = parsedResultKey(result);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const selected: chrono.ParsedResult[] = [];
  for (const result of distinctResults.sort(compareParsedSpecificity)) {
    if (!selected.some((candidate) => containsResult(candidate, result))) {
      selected.push(result);
    }
  }
  return selected.sort((left, right) => left.index - right.index);
}

function parseTrailingClock(
  when: string,
  offset: number,
  reference: chrono.ParsingReference,
  options: chrono.ParsingOption,
): chrono.ParsedResult[] {
  const words = when.trim().split(" ").filter(Boolean);
  for (let index = 0; index < words.length; index += 1) {
    const candidate = `${" ".repeat(offset)}at ${words.slice(index).join(" ")}`;
    const parsed = [
      ...chrono.en.parse(candidate, reference, options),
      ...chrono.es.parse(candidate, reference, options),
    ].filter(hasTime);
    if (parsed.length > 0) return parsed;
  }
  return [];
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

function parsedResultKey(result: chrono.ParsedResult): string {
  return [
    result.index,
    result.text,
    result.start.get("year"),
    result.start.get("month"),
    result.start.get("day"),
    result.start.get("hour"),
    result.start.get("minute"),
  ].join("|");
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

function compareParsedSpecificity(
  left: chrono.ParsedResult,
  right: chrono.ParsedResult,
): number {
  return (
    parsedSpecificity(right) - parsedSpecificity(left) ||
    right.text.length - left.text.length ||
    left.index - right.index
  );
}

function parsedSpecificity(result: chrono.ParsedResult): number {
  return (
    Number(hasDate(result)) +
    Number(hasTime(result) || daypartPreference(result).length > 0)
  );
}

function containsResult(
  outer: chrono.ParsedResult,
  inner: chrono.ParsedResult,
): boolean {
  return (
    outer.index <= inner.index &&
    outer.index + outer.text.length >= inner.index + inner.text.length &&
    parsedSpecificity(outer) >= parsedSpecificity(inner)
  );
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
): AvailabilityTimePreference[] {
  const tags = result.tags();
  if (tags.has("casualReference/morning")) return [{ kind: "morning" }];
  if (tags.has("casualReference/afternoon")) return [{ kind: "afternoon" }];
  return [];
}

function clockTimePreferences(
  result: chrono.ParsedResult,
): AvailabilityTimePreference[] {
  const hour = result.start.get("hour");
  if (hour === null) return [];
  const minute = result.start.get("minute") ?? 0;
  if (
    result.start.isCertain("meridiem") ||
    hour > 12 ||
    result.tags().has("casualReference/noon") ||
    result.tags().has("casualReference/midnight")
  ) {
    return [
      {
        minuteOfDay: normalizedMinuteOfDay(hour, minute),
      },
    ];
  }

  return [
    {
      minuteOfDay: normalizedMinuteOfDay(businessHoursHour(hour), minute),
    },
  ];
}

function businessHoursHour(hour: number): number {
  if (hour >= 1 && hour <= 6) return hour + 12;
  return hour === 12 ? 12 : hour;
}

function callerPreferences(
  results: chrono.ParsedResult[],
  earliestDate: string,
): AvailabilityPreference[] {
  const preferences: AvailabilityPreference[] = [];
  let currentDate: string | undefined;
  for (const result of results) {
    const date = hasDate(result) ? futureDate(result, earliestDate) : undefined;
    if (date) currentDate = date;
    const dayparts = daypartPreference(result);
    const times =
      dayparts.length > 0
        ? dayparts
        : hasTime(result)
          ? clockTimePreferences(result)
          : [];
    if (date && times.length === 0) {
      preferences.push({ date });
      continue;
    }
    if (date) {
      preferences.push(...times.map((time) => ({ date, time })));
      continue;
    }
    if (times.length === 0) continue;

    const previous = preferences.at(-1);
    if (currentDate) {
      if (previous?.date === currentDate && !previous.time) {
        preferences.pop();
      }
      preferences.push(...times.map((time) => ({ date: currentDate, time })));
    } else {
      preferences.push(...times.map((time) => ({ time })));
    }
  }
  return distinctPreferences(preferences);
}

function distinctPreferences(
  values: AvailabilityPreference[],
): AvailabilityPreference[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function distinct(values: string[]): string[] {
  return [...new Set(values)];
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

function minIsoDate(values: string[]): string {
  return [...values].sort()[0] ?? "";
}

function normalizedMinuteOfDay(hour: number, minute: number): number {
  return (hour % 24) * 60 + minute;
}
