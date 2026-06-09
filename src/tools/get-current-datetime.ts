import { llm } from "@livekit/agents";
import { z } from "zod";

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

type ClinicDateTime = ClinicCalendarDate & {
  weekday: string;
  time: string;
};

export function buildCurrentDateTimeMessage(
  now: Date = new Date(),
  datePhrase?: string,
): string {
  const current = clinicDateTime(now);
  const baseMessage = `Today is ${formatSpokenDate(current)} at ${current.time} Eastern time.`;
  const phrase = datePhrase?.trim();
  if (!phrase) return baseMessage;

  return `${baseMessage} ${resolveDatePhraseMessage(phrase, current)}`;
}

function clinicDateTime(now: Date): ClinicDateTime {
  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: CLINIC_TIME_ZONE,
    weekday: "long",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const datePart = (type: Intl.DateTimeFormatPartTypes) =>
    dateParts.find((item) => item.type === type)?.value ?? "";
  const weekday = datePart("weekday");
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: CLINIC_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(now);

  return {
    year: Number(datePart("year")),
    month: Number(datePart("month")),
    day: Number(datePart("day")),
    weekday,
    weekdayIndex: weekdayIndex(weekday),
    time,
  };
}

function resolveDatePhraseMessage(
  phrase: string,
  today: ClinicCalendarDate,
): string {
  const resolved = resolveDatePhrase(phrase, today);
  if (!resolved) {
    return `I could not safely resolve "${phrase}" to one exact date. Ask the caller for a specific date or weekday before checking availability.`;
  }
  if (resolved.status === "clarify") {
    return resolved.message;
  }

  return `I interpreted "${phrase}" as ${formatSpokenDate(resolved.date)}. Use ${isoDate(resolved.date)} when checking availability, and confirm that exact date before booking or rescheduling.`;
}

type ResolvedDatePhrase =
  | { status: "resolved"; date: ClinicCalendarDate }
  | { status: "clarify"; message: string };

function resolveDatePhrase(
  phrase: string,
  today: ClinicCalendarDate,
): ResolvedDatePhrase | null {
  const normalized = normalizeDatePhrase(phrase);
  if (normalized === "today") {
    return { status: "resolved", date: today };
  }
  if (normalized === "tomorrow") {
    return { status: "resolved", date: addCalendarDays(today, 1) };
  }
  if (normalized === "next week") {
    return {
      status: "clarify",
      message:
        '"Next week" is not one exact date. Ask the caller which day next week they want before checking availability.',
    };
  }

  const weekdayMatch = normalized.match(
    /^(?:(this|next)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/,
  );
  if (!weekdayMatch) return null;

  const modifier = weekdayMatch[1] as "this" | "next" | undefined;
  const weekday = weekdayMatch[2] as WeekdayName;
  const targetWeekday = WEEKDAY_INDEX_BY_NAME[weekday];

  if (modifier === "this") {
    const daysAhead = targetWeekday - today.weekdayIndex;
    if (daysAhead < 0) {
      const nextDate = addCalendarDays(
        today,
        daysUntilNextWeekday(today, targetWeekday),
      );
      return {
        status: "clarify",
        message: `"This ${capitalize(weekday)}" has already passed this week. Ask whether the caller means ${formatSpokenDate(nextDate)} or another date before checking availability.`,
      };
    }
    return { status: "resolved", date: addCalendarDays(today, daysAhead) };
  }

  if (modifier === "next") {
    return {
      status: "resolved",
      date: addCalendarDays(today, daysUntilNextWeekday(today, targetWeekday)),
    };
  }

  const daysAhead = (targetWeekday - today.weekdayIndex + 7) % 7;
  return { status: "resolved", date: addCalendarDays(today, daysAhead) };
}

function normalizeDatePhrase(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/[?.!,]/g, " ")
    .replace(/\b(on|for)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function daysUntilNextWeekday(
  today: ClinicCalendarDate,
  targetWeekday: number,
): number {
  const daysAhead = (targetWeekday - today.weekdayIndex + 7) % 7;
  return daysAhead === 0 ? 7 : daysAhead;
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

function formatSpokenDate(date: ClinicCalendarDate): string {
  return `${WEEKDAY_NAMES[date.weekdayIndex]}, ${MONTH_NAMES[date.month - 1]} ${ordinalDay(date.day)}, ${date.year}`;
}

function isoDate(date: ClinicCalendarDate): string {
  return [
    String(date.year).padStart(4, "0"),
    String(date.month).padStart(2, "0"),
    String(date.day).padStart(2, "0"),
  ].join("-");
}

function weekdayIndex(weekday: string): number {
  const index = WEEKDAY_INDEX_BY_NAME[weekday.toLowerCase() as WeekdayName];
  if (index === undefined) {
    throw new Error(`Unexpected clinic-local weekday: ${weekday}`);
  }
  return index;
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
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

export const get_current_datetime = llm.tool({
  description:
    "Get the current clinic-local date and time in America/New_York. " +
    "Call this before interpreting relative dates or times for scheduling, availability, booking, or appointment changes, including phrases like today, tomorrow, next week, Friday, this morning, or this afternoon. " +
    "Pass datePhrase when the caller used relative date language, such as today, tomorrow, Wednesday, this Wednesday, or next Wednesday. " +
    "This tool returns natural English with the exact YYYY-MM-DD date when one can be resolved, or tells you to clarify if the phrase is not one exact date. " +
    "This tool is read-only; it does not schedule, book, cancel, or call external systems.",
  parameters: z.object({
    datePhrase: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Caller-provided relative date phrase to resolve, such as today, tomorrow, Wednesday, this Wednesday, or next Wednesday. Omit if only the current clinic-local date and time is needed.",
      ),
  }),
  execute: async ({ datePhrase }) =>
    buildCurrentDateTimeMessage(new Date(), datePhrase),
});
