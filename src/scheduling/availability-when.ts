import * as chrono from "chrono-node";
import type { AvailabilityWindow } from "../clients/owned-middleware.js";
import type {
  AvailabilityPreferenceBranch,
  AvailabilityTimeConstraint,
} from "../state/call-state.js";

const CLINIC_TIME_ZONE = "America/New_York";
const SEARCH_DATE_COUNT = 15;
const AROUND_RADIUS_MINUTES = 60;

export type NormalizedAvailabilityBranch = AvailabilityPreferenceBranch;

export type AvailabilitySemanticBranchInput = {
  datePhrase: string | null;
  time: AvailabilityTimeConstraint | null;
};

export type ConcreteAvailabilityQuery = {
  timeZone: "America/New_York";
  windows: AvailabilityWindow[];
};

export class AvailabilityClarificationNeeded extends Error {}

export interface SchedulingClock {
  now(): Date;
}

export const systemSchedulingClock: SchedulingClock = {
  now: () => new Date(),
};

export function mergeAvailabilityBranches(
  input: AvailabilitySemanticBranchInput[],
  previous: NormalizedAvailabilityBranch[],
  clock: SchedulingClock,
): NormalizedAvailabilityBranch[] {
  if (input.length === 0) {
    throw new Error("At least one availability branch is required.");
  }
  const now = clock.now();
  const earliestDate = addIsoDays(clinicIsoDate(now), 1);
  const previousTimes = distinctValues(
    previous.map((branch) => branch.time),
    (value) => JSON.stringify(value),
  );
  const branches = input.flatMap((branch) => {
    const datePhrase = branch.datePhrase?.trim();
    if (!datePhrase) {
      const inherited =
        previous.length > 0
          ? previous
          : [
              {
                dates: datesForPhrase("next available", now, earliestDate),
                time: { operator: "any" as const },
              },
            ];
      return inherited.map((previousBranch) => ({
        dates: [...previousBranch.dates],
        time: branch.time ?? previousBranch.time,
      }));
    }
    const times = branch.time
      ? [branch.time]
      : previousTimes.length <= 1
        ? [previousTimes[0] ?? { operator: "any" as const }]
        : [];
    if (times.length === 0) {
      throw new AvailabilityClarificationNeeded(
        "Ask which prior time preference the caller wants to keep, then check availability again.",
      );
    }
    const dates = datesForPhrase(datePhrase, now, earliestDate);
    return times.map((time) => ({ dates, time }));
  });
  const distinct = distinctValues(branches, (branch) => JSON.stringify(branch));
  if (distinct.length > 15) {
    throw new AvailabilityClarificationNeeded(
      "Ask the caller to narrow the acceptable dates or times, then check availability again.",
    );
  }
  return distinct;
}

function distinctValues<T>(values: T[], keyFor: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [keyFor(value), value])).values()];
}

export function resolveAvailabilityBranches(
  branches: NormalizedAvailabilityBranch[],
  clock: SchedulingClock,
): ConcreteAvailabilityQuery {
  const now = clock.now();
  const windows = branches.flatMap((branch) =>
    branch.dates.map((date) => concreteWindow(date, branch.time, now)),
  );
  if (windows.length === 0) {
    throw new Error("At least one availability branch is required.");
  }
  const distinct = new Map<string, AvailabilityWindow>();
  for (const window of windows) {
    const key = `${window.start}|${window.end}|${window.preferredStart ?? ""}`;
    distinct.set(key, window);
  }
  return {
    timeZone: CLINIC_TIME_ZONE,
    windows: [...distinct.values()].sort((left, right) =>
      left.start.localeCompare(right.start),
    ),
  };
}

export function exactAvailabilityQueryForSlot(
  datetime: string,
): ConcreteAvailabilityQuery {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(datetime);
  if (!match) throw new Error("The offered slot datetime is invalid.");
  const date = match[1] ?? "";
  const minuteOfDay = Number(match[2]) * 60 + Number(match[3]);
  const start = clinicLocalTimestamp(date, minuteOfDay);
  return {
    timeZone: CLINIC_TIME_ZONE,
    windows: [
      {
        start,
        end: clinicLocalTimestamp(date, minuteOfDay + 1),
        preferredStart: start,
      },
    ],
  };
}

function datesForPhrase(
  phrase: string,
  now: Date,
  earliestDate: string,
): string[] {
  const reference = { instant: clinicReferenceDate(now), timezone: 0 };
  const options = { forwardDate: true };
  const parsed = [
    ...chrono.en.parse(phrase, reference, options),
    ...chrono.es.parse(phrase, reference, options),
  ]
    .filter(hasDate)
    .sort((left, right) => left.index - right.index)[0];
  if (!parsed) {
    if (!isBroadDatePhrase(phrase)) {
      throw new AvailabilityClarificationNeeded(
        "Ask the caller for a specific date or whether they want the next available appointment, then call get_availability again.",
      );
    }
    return Array.from({ length: SEARCH_DATE_COUNT }, (_, index) =>
      addIsoDays(earliestDate, index),
    );
  }
  const monthRange = parsedMonthRange(parsed, earliestDate);
  const start = monthRange?.start ?? futureDate(parsed, earliestDate);
  const end = parsed.end
    ? componentIsoDateFromComponents(parsed.end)
    : (monthRange?.end ?? impliedRangeEnd(phrase, start) ?? start);
  const last = end < start ? start : end;
  const dates: string[] = [];
  for (
    let date = start;
    date <= last && dates.length < SEARCH_DATE_COUNT;
    date = addIsoDays(date, 1)
  ) {
    dates.push(date);
  }
  return dates;
}

function parsedMonthRange(
  parsed: chrono.ParsedResult,
  earliestDate: string,
): { start: string; end: string } | undefined {
  if (
    !parsed.start.isCertain("month") ||
    parsed.start.isCertain("day") ||
    parsed.end
  ) {
    return undefined;
  }
  const year = requiredParsedComponent(parsed.start, "year");
  const month = requiredParsedComponent(parsed.start, "month");
  const start = clampDate(isoDate(year, month, 1), earliestDate);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start, end: isoDate(year, month, lastDay) };
}

function impliedRangeEnd(phrase: string, start: string): string | undefined {
  const normalized = phrase.trim().toLocaleLowerCase("en-US");
  return /\b(?:next week|pr[oó]xima semana)\b/.test(normalized)
    ? addIsoDays(start, 6)
    : undefined;
}

function isBroadDatePhrase(phrase: string): boolean {
  const normalized = phrase.trim().toLocaleLowerCase("en-US");
  return (
    /\b(?:any day|any date|earliest|first available|next available|soonest|whenever|as soon as possible|cualquier d[ií]a|la pr[oó]xima disponible|lo antes posible)\b/.test(
      normalized,
    ) || normalized === "any"
  );
}

function concreteWindow(
  date: string,
  time: AvailabilityTimeConstraint,
  now: Date,
): AvailabilityWindow {
  let startMinute = 0;
  let endMinute = 24 * 60;
  let preferredMinute: number | undefined;
  switch (time.operator) {
    case "morning":
      endMinute = 12 * 60;
      break;
    case "afternoon":
      startMinute = 12 * 60;
      break;
    case "exact":
      preferredMinute = clockMinuteOfDay(time.clockPhrase, now);
      startMinute = preferredMinute;
      endMinute = preferredMinute + 1;
      break;
    case "around":
      preferredMinute = clockMinuteOfDay(time.clockPhrase, now);
      startMinute = Math.max(0, preferredMinute - AROUND_RADIUS_MINUTES);
      endMinute = Math.min(
        24 * 60,
        preferredMinute + AROUND_RADIUS_MINUTES + 1,
      );
      break;
    case "before":
      endMinute = clockMinuteOfDay(time.clockPhrase, now);
      break;
    case "after":
      startMinute = clockMinuteOfDay(time.clockPhrase, now);
      break;
    case "any":
      break;
  }
  if (startMinute >= endMinute) {
    throw new Error(
      "The availability time branch does not contain a usable window.",
    );
  }
  return {
    start: clinicLocalTimestamp(date, startMinute),
    end: clinicLocalTimestamp(date, endMinute),
    ...(preferredMinute === undefined
      ? {}
      : { preferredStart: clinicLocalTimestamp(date, preferredMinute) }),
  };
}

function clockMinuteOfDay(phrase: string, now: Date): number {
  const reference = { instant: clinicReferenceDate(now), timezone: 0 };
  const options = { forwardDate: true };
  const parseablePhrase = explicitSpanishMeridiem(phrase) ?? phrase;
  const parsed = [
    ...chrono.en.parse(`at ${parseablePhrase}`, reference, options),
    ...chrono.es.parse(`a las ${parseablePhrase}`, reference, options),
  ]
    .filter(hasTime)
    .sort((left, right) => right.text.length - left.text.length)[0];
  if (!parsed) {
    throw new AvailabilityClarificationNeeded(
      "Ask the caller for a specific clock time, then call get_availability with the clarified clock phrase.",
    );
  }
  const parsedHour = parsed.start.get("hour");
  if (
    parsedHour !== null &&
    parsedHour >= 1 &&
    parsedHour <= 12 &&
    !parsed.start.isCertain("meridiem") &&
    !parsed.tags().has("casualReference/noon") &&
    !parsed.tags().has("casualReference/midnight")
  ) {
    throw new AvailabilityClarificationNeeded(
      `Ask whether the caller means ${parsedHour} AM or ${parsedHour} PM, then call get_availability with the clarified clock phrase.`,
    );
  }
  if (parsedHour === null) {
    throw new AvailabilityClarificationNeeded(
      "Ask the caller for a specific clock time, then call get_availability with the clarified clock phrase.",
    );
  }
  return normalizedMinuteOfDay(parsedHour, parsed.start.get("minute") ?? 0);
}

function explicitSpanishMeridiem(phrase: string): string | undefined {
  const meridiem = /\b(?:de la\s+)?(ma[nñ]ana|tarde|noche)\b/i.exec(
    phrase,
  )?.[1];
  const clock = /\b(\d{1,2})(?::(\d{2}))?\b/.exec(phrase);
  if (!meridiem || !clock) return undefined;
  const suffix = /tarde|noche/i.test(meridiem) ? "PM" : "AM";
  return `${clock[1]}:${clock[2] ?? "00"} ${suffix}`;
}

function clinicLocalTimestamp(date: string, minuteOfDay: number): string {
  const nextDate = minuteOfDay === 24 * 60 ? addIsoDays(date, 1) : date;
  const normalizedMinute = minuteOfDay === 24 * 60 ? 0 : minuteOfDay;
  const hour = Math.floor(normalizedMinute / 60);
  const minute = normalizedMinute % 60;
  const instant = clinicLocalInstant(nextDate, hour, minute);
  const offsetMinutes =
    (Date.UTC(
      Number(nextDate.slice(0, 4)),
      Number(nextDate.slice(5, 7)) - 1,
      Number(nextDate.slice(8, 10)),
      hour,
      minute,
    ) -
      instant.getTime()) /
    60_000;
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absoluteOffset / 60)).padStart(2, "0")}:${String(absoluteOffset % 60).padStart(2, "0")}`;
  return `${nextDate}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00${offset}`;
}

function clinicLocalInstant(date: string, hour: number, minute: number): Date {
  const target = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
    hour,
    minute,
  );
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = clinicParts(new Date(instant), {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const observed = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
    );
    instant += target - observed;
  }
  return new Date(instant);
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
  return componentIsoDateFromComponents(result.start);
}

function componentIsoDateFromComponents(
  components: chrono.ParsedComponents,
): string {
  return isoDate(
    requiredParsedComponent(components, "year"),
    requiredParsedComponent(components, "month"),
    requiredParsedComponent(components, "day"),
  );
}

function requiredParsedComponent(
  components: chrono.ParsedComponents,
  component: "year" | "month" | "day",
): number {
  const value = components.get(component);
  if (value === null) {
    throw new Error(`Chrono omitted ${component} from a parsed calendar date.`);
  }
  return value;
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

export function clinicIsoDate(instant: Date): string {
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
