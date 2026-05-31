import { llm } from "@livekit/agents";
import { z } from "zod";

const CLINIC_TIME_ZONE = "America/New_York";

export function buildCurrentDateTimeMessage(now: Date = new Date()): string {
  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: CLINIC_TIME_ZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).formatToParts(now);
  const datePart = (type: Intl.DateTimeFormatPartTypes) =>
    dateParts.find((item) => item.type === type)?.value ?? "";
  const day = Number(datePart("day"));
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: CLINIC_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(now);

  return `Today is ${datePart("weekday")}, ${datePart("month")} ${ordinalDay(day)}, ${datePart("year")} at ${time} Eastern time.`;
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
    "This tool returns one short sentence and is read-only; it does not schedule, book, cancel, or call external systems.",
  parameters: z.object({}),
  execute: async () => buildCurrentDateTimeMessage(),
});
