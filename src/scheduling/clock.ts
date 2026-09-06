const CLINIC_TIME_ZONE = "America/New_York";
export interface SchedulingClock {
  now(): Date;
}
export const systemSchedulingClock: SchedulingClock = { now: () => new Date() };
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
    "Appointment dates and times come from the loaded clinic-local inventory."
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
