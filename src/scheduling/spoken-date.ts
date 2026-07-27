const MONTHS = [
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
];

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

export function spokenAppointmentDate(value: string): string {
  const input = value.trim();
  const date = parseAppointmentDate(input);
  return date ? DATE_FORMATTER.format(date) : input;
}

function parseAppointmentDate(value: string): Date | null {
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (isoMatch) {
    return validUtcDate(
      Number(isoMatch[1]),
      Number(isoMatch[2]),
      Number(isoMatch[3]),
    );
  }

  const longMatch =
    /^(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s*)?([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(
      value,
    );
  if (!longMatch) return null;

  const month = MONTHS.indexOf(longMatch[1] ?? "") + 1;
  if (month === 0) return null;
  return validUtcDate(Number(longMatch[3]), month, Number(longMatch[2]));
}

function validUtcDate(year: number, month: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null;
}
