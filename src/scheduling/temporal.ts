import { z } from "zod";
import type { AvailabilityPreference } from "../clients/owned-middleware.js";

const CLINIC_TIME_ZONE = "America/New_York";

const WEEKDAY_INDEX_BY_NAME = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
} as const;

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

type WeekdayName = keyof typeof WEEKDAY_INDEX_BY_NAME;

type ClinicCalendarDate = {
  year: number;
  month: number;
  day: number;
  weekdayIndex: number;
};

export interface SchedulingClock {
  now(): Date;
}

export const systemSchedulingClock: SchedulingClock = {
  now: () => new Date(),
};

const availabilityDatePreferenceSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("today") }).strict(),
    z.object({ kind: z.literal("tomorrow") }).strict(),
    z.object({ kind: z.literal("next_week") }).strict(),
    z
      .object({
        kind: z.literal("relative"),
        value: z.number().int().min(1).max(365),
        unit: z.enum(["day", "week"]),
      })
      .strict(),
    z
      .object({
        kind: z.literal("calendar"),
        month: z.number().int().min(1).max(12),
        day: z.number().int().min(1).max(31),
        year: z.number().int().min(1900).max(9999).optional(),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (
      value.kind === "calendar" &&
      !buildCalendarDate(value.year ?? 2000, value.month, value.day)
    ) {
      context.addIssue({
        code: "custom",
        message: "Calendar date must exist.",
      });
    }
  })
  .describe(
    "Semantic caller date: today, tomorrow, next week, a relative day/week offset, or calendar month/day/year. Do not calculate an ISO date.",
  );

const availabilityTimePreferenceSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("any") }).strict(),
    z.object({ kind: z.literal("morning") }).strict(),
    z.object({ kind: z.literal("afternoon") }).strict(),
    ...(["exact", "around", "before", "after"] as const).map((kind) =>
      z
        .object({
          kind: z.literal(kind),
          hour: z.number().int().min(1).max(12),
          minute: z.number().int().min(0).max(59),
          meridiem: z.enum(["am", "pm"]),
        })
        .strict(),
    ),
  ])
  .describe(
    "Semantic caller time: any, morning, afternoon, or a structured clock time qualified as exact, around, before, or after.",
  );

export const availabilityPreferenceListSchema = z
  .array(
    z
      .object({
        date: availabilityDatePreferenceSchema
          .optional()
          .describe(
            "Semantic date anchor from the caller. Omit when they have no date preference.",
          ),
        weekday: z
          .enum([
            "sunday",
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday",
            "saturday",
          ])
          .optional()
          .describe(
            "Preferred weekday in lowercase English. Use a separate branch for each OR alternative.",
          ),
        time: availabilityTimePreferenceSchema
          .optional()
          .describe(
            "Semantic time preference. Omit or use any when the caller accepts any time.",
          ),
      })
      .strict(),
  )
  .max(8)
  .describe(
    "Caller scheduling preferences. Fields in one branch are AND; branches are OR. Omit or pass [] for next available without date or time preferences.",
  );

export type AvailabilityPreferenceInput = z.infer<
  typeof availabilityPreferenceListSchema
>[number];

export function resolveAvailabilityPreferences(
  input: AvailabilityPreferenceInput[] | undefined,
  clock: SchedulingClock,
): { date: string; preferences?: AvailabilityPreference[] } {
  const today = clinicCalendarDate(clock.now());
  const todayIso = isoDate(today);
  const branches = (input ?? []).map((branch) =>
    canonicalAvailabilityPreference(branch, today),
  );
  if (branches.some((branch) => Object.keys(branch).length === 0)) {
    return { date: todayIso };
  }

  const preferences = [
    ...new Map(
      branches
        .map((branch) => [JSON.stringify(branch), branch] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    ).values(),
  ];
  if (preferences.length === 0) return { date: todayIso };

  const dates = preferences.map((preference) => preference.date);
  const startDate = dates.every(Boolean)
    ? (dates.sort()[0] ?? todayIso)
    : todayIso;
  return {
    date: startDate < todayIso ? todayIso : startDate,
    preferences,
  };
}

export function clinicTimestampMessage(now: Date): string {
  const date = clinicCalendarDate(now);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: CLINIC_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(now);
  return (
    `Current clinic-local date and time for this turn: ${formatSpokenDate(date)} at ${time} Eastern time. ` +
    "Scheduling tools resolve semantic caller date preferences independently when called."
  );
}

function canonicalAvailabilityPreference(
  input: AvailabilityPreferenceInput,
  today: ClinicCalendarDate,
): AvailabilityPreference {
  const date = input.date
    ? resolvePreferenceDate(input.date, input.weekday, today)
    : undefined;
  const time = canonicalTimePreference(input.time);
  return {
    ...(date ? { date } : {}),
    ...(input.weekday ? { weekday: input.weekday } : {}),
    ...(time ? { time } : {}),
  };
}

function resolvePreferenceDate(
  input: NonNullable<AvailabilityPreferenceInput["date"]>,
  weekday: AvailabilityPreferenceInput["weekday"],
  today: ClinicCalendarDate,
): string | undefined {
  switch (input.kind) {
    case "today":
      return isoDate(today);
    case "tomorrow":
      return isoDate(addCalendarDays(today, 1));
    case "next_week": {
      const start = addCalendarDays(today, 7 - today.weekdayIndex);
      return isoDate(
        weekday
          ? addCalendarDays(start, WEEKDAY_INDEX_BY_NAME[weekday])
          : start,
      );
    }
    case "relative":
      return isoDate(
        addCalendarDays(today, input.value * (input.unit === "week" ? 7 : 1)),
      );
    case "calendar": {
      const date =
        input.year === undefined
          ? nextValidMonthDay(today, input.month, input.day)
          : buildCalendarDate(input.year, input.month, input.day);
      return date ? isoDate(date) : undefined;
    }
  }
}

function canonicalTimePreference(
  input: AvailabilityPreferenceInput["time"],
): AvailabilityPreference["time"] {
  if (!input || input.kind === "any") return undefined;
  if (input.kind === "morning" || input.kind === "afternoon") {
    return { kind: input.kind };
  }
  return {
    kind: input.kind,
    minuteOfDay: clockMinuteOfDay(input.hour, input.minute, input.meridiem),
  };
}

function clinicCalendarDate(now: Date): ClinicCalendarDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CLINIC_TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "long",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  const weekday = part("weekday").toLowerCase() as WeekdayName;
  return {
    year: Number(part("year")),
    month: Number(part("month")),
    day: Number(part("day")),
    weekdayIndex: WEEKDAY_INDEX_BY_NAME[weekday],
  };
}

function addCalendarDays(
  date: ClinicCalendarDate,
  days: number,
): ClinicCalendarDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    weekdayIndex: next.getUTCDay(),
  };
}

function nextValidMonthDay(
  today: ClinicCalendarDate,
  month: number,
  day: number,
): ClinicCalendarDate | null {
  for (let year = today.year; year <= today.year + 8; year += 1) {
    const date = buildCalendarDate(year, month, day);
    if (date && compareCalendarDates(date, today) >= 0) return date;
  }
  return null;
}

function buildCalendarDate(
  year: number,
  month: number,
  day: number,
): ClinicCalendarDate | null {
  if (year < 1000 || year > 9999) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return {
    year,
    month,
    day,
    weekdayIndex: date.getUTCDay(),
  };
}

function compareCalendarDates(
  left: ClinicCalendarDate,
  right: ClinicCalendarDate,
): number {
  if (left.year !== right.year) return left.year - right.year;
  if (left.month !== right.month) return left.month - right.month;
  return left.day - right.day;
}

function isoDate(date: ClinicCalendarDate): string {
  return [
    String(date.year).padStart(4, "0"),
    String(date.month).padStart(2, "0"),
    String(date.day).padStart(2, "0"),
  ].join("-");
}

function formatSpokenDate(date: ClinicCalendarDate): string {
  return `${WEEKDAY_NAMES[date.weekdayIndex]}, ${MONTH_NAMES[date.month - 1]} ${ordinalDay(date.day)}, ${date.year}`;
}

function clockMinuteOfDay(
  hour: number,
  minute: number,
  meridiem: "am" | "pm",
): number {
  const hour24 =
    meridiem === "am" ? (hour === 12 ? 0 : hour) : hour === 12 ? 12 : hour + 12;
  return hour24 * 60 + minute;
}

function ordinalDay(day: number): string {
  const remainder = day % 100;
  if (remainder >= 11 && remainder <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}
