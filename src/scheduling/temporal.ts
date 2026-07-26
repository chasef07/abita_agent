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

const WEEKDAY_ALIASES: Record<string, keyof typeof WEEKDAY_INDEX_BY_NAME> = {
  sun: "sunday",
  mon: "monday",
  tue: "tuesday",
  tues: "tuesday",
  wed: "wednesday",
  weds: "wednesday",
  thu: "thursday",
  thur: "thursday",
  thurs: "thursday",
  fri: "friday",
  sat: "saturday",
};

const SPANISH_WEEKDAY_NAMES: Record<
  string,
  keyof typeof WEEKDAY_INDEX_BY_NAME
> = {
  domingo: "sunday",
  lunes: "monday",
  martes: "tuesday",
  miercoles: "wednesday",
  jueves: "thursday",
  viernes: "friday",
  sabado: "saturday",
};

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

const MONTH_INDEX_BY_NAME = MONTH_NAMES.reduce<Record<string, number>>(
  (months, month, index) => {
    const monthIndex = index + 1;
    months[month.toLowerCase()] = monthIndex;
    months[month.slice(0, 3).toLowerCase()] = monthIndex;
    if (month === "September") months.sept = monthIndex;
    return months;
  },
  {},
);

const SPANISH_MONTH_NAMES: Record<string, string> = {
  enero: "january",
  febrero: "february",
  marzo: "march",
  abril: "april",
  mayo: "may",
  junio: "june",
  julio: "july",
  agosto: "august",
  septiembre: "september",
  octubre: "october",
  noviembre: "november",
  diciembre: "december",
};

const WEEKDAY_PATTERN =
  "sunday|monday|tuesday|wednesday|thursday|friday|saturday";
const MONTH_PATTERN =
  "january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec";
const EARLIEST_AVAILABILITY_PATTERN =
  /^(?:any day|as soon as (?:possible|available)|earliest(?: available)?|soonest(?: available)?|first available|next available|sometime soon|soon)$/;

const RELATIVE_NUMBER_BY_NAME: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

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

export type AvailabilityTimeConstraint =
  | { kind: "morning" }
  | { kind: "afternoon" }
  | { kind: "exact"; minutes: number }
  | { kind: "near"; minutes: number }
  | { kind: "before"; minutes: number }
  | { kind: "after"; minutes: number };

export type AvailabilityDateSearchMode = "specific" | "earliest";

export type AvailabilityWhenResolution =
  | {
      status: "resolved";
      date: string;
      dateSearchMode: AvailabilityDateSearchMode;
      timeConstraint: AvailabilityTimeConstraint | null;
    }
  | { status: "clarify"; message: string }
  | { status: "invalid"; message: string };

export const systemSchedulingClock: SchedulingClock = {
  now: () => new Date(),
};

export function resolveAvailabilityWhen(
  when: string,
  clock: SchedulingClock,
): AvailabilityWhenResolution {
  const normalized = normalizeWhen(when);
  if (!normalized) {
    return {
      status: "clarify",
      message:
        "Ask what day the caller wants before checking appointment availability.",
    };
  }

  const time = resolveTimeConstraint(normalized);
  if (time.status !== "resolved") return time;

  const today = clinicCalendarDate(clock.now());
  const date = resolveDatePhrase(time.datePhrase, today);
  if (date.status !== "resolved") return date;
  const resolvedDate = isoDate(date.date);
  const clinicToday = isoDate(today);

  return {
    status: "resolved",
    date: resolvedDate,
    dateSearchMode:
      resolvedDate === clinicToday ||
      EARLIEST_AVAILABILITY_PATTERN.test(time.datePhrase)
        ? "earliest"
        : "specific",
    timeConstraint: time.timeConstraint,
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
    "Scheduling tools resolve caller date language independently when called."
  );
}

export function timeConstraintCacheValue(
  constraint: AvailabilityTimeConstraint | null,
): string | null {
  if (!constraint) return null;
  return "minutes" in constraint
    ? `${constraint.kind}:${constraint.minutes}`
    : constraint.kind;
}

export function slotMatchesTimeConstraint(
  minutes: number,
  constraint: AvailabilityTimeConstraint,
): boolean {
  switch (constraint.kind) {
    case "morning":
      return minutes < 12 * 60;
    case "afternoon":
      return minutes >= 12 * 60;
    case "exact":
      return minutes === constraint.minutes;
    case "near":
      return true;
    case "before":
      return minutes < constraint.minutes;
    case "after":
      return minutes > constraint.minutes;
  }
}

export function parseClockMinutes(value: string): number | null {
  const match = value
    .trim()
    .match(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/i);
  if (!match) return null;
  return clockMinutes(
    Number(match[1]),
    Number(match[2] ?? "0"),
    match[3].toLowerCase() as "am" | "pm",
  );
}

export function describeTimeConstraint(
  constraint: AvailabilityTimeConstraint,
): string {
  switch (constraint.kind) {
    case "morning":
      return "morning";
    case "afternoon":
      return "afternoon";
    case "exact":
      return `time of ${formatClockMinutes(constraint.minutes)}`;
    case "near":
      return `time around ${formatClockMinutes(constraint.minutes)}`;
    case "before":
      return `time before ${formatClockMinutes(constraint.minutes)}`;
    case "after":
      return `time after ${formatClockMinutes(constraint.minutes)}`;
  }
}

type TimeResolution =
  | {
      status: "resolved";
      datePhrase: string;
      timeConstraint: AvailabilityTimeConstraint | null;
    }
  | Extract<AvailabilityWhenResolution, { status: "clarify" | "invalid" }>;

function resolveTimeConstraint(normalized: string): TimeResolution {
  if (/\b(?:early|late)\s+(?:morning|afternoon)\b/.test(normalized)) {
    return {
      status: "clarify",
      message:
        "Ask the caller for a specific clock time instead of early or late.",
    };
  }

  const dayPartMatches = [
    ...normalized.matchAll(/\b(?:in\s+the\s+)?(morning|afternoon)\b/g),
  ];
  const dayParts = new Set(dayPartMatches.map((match) => match[1]));
  if (dayParts.size > 1 || dayPartMatches.length > 1) {
    return {
      status: "clarify",
      message:
        "Ask the caller for one time preference before checking availability.",
    };
  }

  const explicitTimeMatches = [
    ...normalized.matchAll(
      /\b(?:(around|about|before|after|at)\s+)?(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/g,
    ),
  ];
  const noonMatches = [
    ...normalized.matchAll(/\b(?:(around|about|before|after|at)\s+)?(noon)\b/g),
  ];
  if (explicitTimeMatches.length + noonMatches.length > 1) {
    return {
      status: "clarify",
      message:
        "Ask the caller for one specific time before checking availability.",
    };
  }

  const explicitTime = explicitTimeMatches[0];
  const noon = noonMatches[0];
  let clockMatch: RegExpMatchArray | undefined = explicitTime ?? noon;
  let timeConstraint: AvailabilityTimeConstraint | null = dayParts.has(
    "morning",
  )
    ? { kind: "morning" }
    : dayParts.has("afternoon")
      ? { kind: "afternoon" }
      : null;

  if (explicitTime || noon) {
    const minutes = noon ? 12 * 60 : parseClockMinutes(explicitTime[0]);
    if (minutes === null) {
      return {
        status: "invalid",
        message:
          "That clock time is not valid. Ask the caller for a valid time.",
      };
    }
    const qualifier = (explicitTime ?? noon)[1];
    const kind =
      qualifier === "around" || qualifier === "about"
        ? "near"
        : qualifier === "before" || qualifier === "after"
          ? qualifier
          : "exact";
    const dayPart = [...dayParts][0];
    if (
      (dayPart === "morning" && minutes >= 12 * 60) ||
      (dayPart === "afternoon" && minutes < 12 * 60)
    ) {
      return {
        status: "clarify",
        message:
          "The day-part and clock time do not agree. Ask the caller which time they mean.",
      };
    }
    timeConstraint = { kind, minutes };
  } else {
    const bareTime = normalized.match(
      /\b(around|about|before|after|at)\s+(\d{1,2})(?::(\d{1,2}))?\b/,
    );
    if (bareTime) {
      const hour = Number(bareTime[2]);
      const minute = Number(bareTime[3] ?? "0");
      if (hour < 1 || hour > 12 || minute < 0 || minute > 59) {
        return {
          status: "invalid",
          message:
            "That clock time is not valid. Ask the caller for a valid time.",
        };
      }
      const dayPart = [...dayParts][0];
      if (!dayPart) {
        return {
          status: "clarify",
          message:
            "Ask whether the caller means AM or PM before checking availability.",
        };
      }
      const qualifier = bareTime[1];
      const kind =
        qualifier === "around" || qualifier === "about"
          ? "near"
          : qualifier === "before" || qualifier === "after"
            ? qualifier
            : "exact";
      timeConstraint = {
        kind,
        minutes: clockMinutes(
          hour,
          minute,
          dayPart === "morning" ? "am" : "pm",
        ),
      };
      clockMatch = bareTime;
    }
  }

  let datePhrase = normalized;
  if (clockMatch) datePhrase = removeMatch(datePhrase, clockMatch);
  for (const dayPartMatch of dayPartMatches) {
    datePhrase = removeMatchedText(datePhrase, dayPartMatch[0]);
  }
  datePhrase = normalizeDatePhrase(datePhrase);
  if (
    !datePhrase &&
    (timeConstraint !== null ||
      /^(?:any\s*time|anytime|whenever)$/.test(normalized))
  ) {
    datePhrase = "next available";
  }
  if (!datePhrase) {
    return {
      status: "clarify",
      message:
        "Ask what day the caller wants before checking appointment availability.",
    };
  }

  return { status: "resolved", datePhrase, timeConstraint };
}

type DateResolution =
  | { status: "resolved"; date: ClinicCalendarDate }
  | Extract<AvailabilityWhenResolution, { status: "clarify" | "invalid" }>;

function resolveDatePhrase(
  phrase: string,
  today: ClinicCalendarDate,
): DateResolution {
  if (phrase === "today") {
    return { status: "resolved", date: today };
  }
  if (phrase === "tomorrow") {
    return { status: "resolved", date: addCalendarDays(today, 1) };
  }
  if (/^(?:the\s+)?day after tomorrow$/.test(phrase)) {
    return { status: "resolved", date: addCalendarDays(today, 2) };
  }
  if (
    new RegExp(
      `^(?:(?:the\\s+)?following|(?:el\\s+)?proximo)\\s+(?:${WEEKDAY_PATTERN})$`,
    ).test(phrase)
  ) {
    return {
      status: "clarify",
      message:
        "Ask the caller for the exact calendar date because that weekday phrase is ambiguous.",
    };
  }
  if (/^(?:(?:sometime|any day|anytime|whenever)\s+)?next week$/.test(phrase)) {
    return {
      status: "resolved",
      date: addCalendarDays(today, 7 - today.weekdayIndex),
    };
  }
  if (/^(?:(?:sometime|any day|anytime|whenever)\s+)?this week$/.test(phrase)) {
    if (today.weekdayIndex === WEEKDAY_INDEX_BY_NAME.saturday) {
      return {
        status: "clarify",
        message:
          "There are no future days left this week. Ask whether the caller wants to start next week.",
      };
    }
    return { status: "resolved", date: addCalendarDays(today, 1) };
  }
  if (/\b(?:or|and)\b/.test(phrase)) {
    return {
      status: "clarify",
      message:
        "Ask the caller for one specific day before checking availability.",
    };
  }
  if (EARLIEST_AVAILABILITY_PATTERN.test(phrase)) {
    return { status: "resolved", date: today };
  }

  const relativeMatch = phrase.match(
    /^in\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(day|days|week|weeks)$/,
  );
  if (relativeMatch) {
    const amount =
      RELATIVE_NUMBER_BY_NAME[relativeMatch[1]] ?? Number(relativeMatch[1]);
    const days = relativeMatch[2].startsWith("week") ? amount * 7 : amount;
    if (amount <= 0) {
      return {
        status: "invalid",
        message:
          "Ask the caller for a future day before checking availability.",
      };
    }
    return { status: "resolved", date: addCalendarDays(today, days) };
  }
  if (/\bweek(?:end)?\b/.test(phrase)) {
    return {
      status: "clarify",
      message:
        "Ask which specific day of the week the caller wants before checking availability.",
    };
  }

  const isoMatch = phrase.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return resolveExplicitDate(
      Number(isoMatch[1]),
      Number(isoMatch[2]),
      Number(isoMatch[3]),
      today,
    );
  }

  if (/^\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?$/.test(phrase)) {
    return {
      status: "clarify",
      message:
        "That numeric date is ambiguous. Ask the caller to say the month name and day.",
    };
  }

  const weekdayDateMatch = phrase.match(
    new RegExp(
      `^(${WEEKDAY_PATTERN})\\s+((?:${MONTH_PATTERN})\\s+(?:the\\s+)?\\d{1,2}(?:\\s+\\d{4})?|(?:the\\s+)?\\d{1,2}\\s+(?:of\\s+)?(?:${MONTH_PATTERN})(?:\\s+\\d{4})?)$`,
    ),
  );
  if (weekdayDateMatch) {
    const date = resolveDatePhrase(weekdayDateMatch[2], today);
    if (date.status !== "resolved") return date;
    const weekday = weekdayDateMatch[1] as WeekdayName;
    if (date.date.weekdayIndex !== WEEKDAY_INDEX_BY_NAME[weekday]) {
      return {
        status: "invalid",
        message:
          "That weekday does not match the calendar date. Ask the caller to confirm the date.",
      };
    }
    return date;
  }

  const monthDayMatch = phrase.match(
    new RegExp(
      `^(${MONTH_PATTERN})\\s+(?:the\\s+)?(\\d{1,2})(?:\\s+(\\d{4}))?$`,
    ),
  );
  if (monthDayMatch) {
    const month = MONTH_INDEX_BY_NAME[monthDayMatch[1]];
    const day = Number(monthDayMatch[2]);
    const explicitYear = monthDayMatch[3]
      ? Number(monthDayMatch[3])
      : undefined;
    if (explicitYear !== undefined) {
      return resolveExplicitDate(explicitYear, month, day, today);
    }

    const nextDate = nextValidMonthDay(today, month, day);
    if (!nextDate) {
      return {
        status: "invalid",
        message:
          "That calendar date is not valid. Ask the caller for a valid date.",
      };
    }
    return { status: "resolved", date: nextDate };
  }

  const dayMonthMatch = phrase.match(
    new RegExp(
      `^(?:the\\s+)?(\\d{1,2})\\s+(?:of\\s+)?(${MONTH_PATTERN})(?:\\s+(\\d{4}))?$`,
    ),
  );
  if (dayMonthMatch) {
    const [, day, month, year] = dayMonthMatch;
    return resolveDatePhrase(`${month} ${day}${year ? ` ${year}` : ""}`, today);
  }

  const weekdayMatch = phrase.match(
    /^(?:(this|next)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/,
  );
  if (weekdayMatch) {
    const modifier = weekdayMatch[1] as "this" | "next" | undefined;
    const weekday = weekdayMatch[2] as WeekdayName;
    const targetWeekday = WEEKDAY_INDEX_BY_NAME[weekday];
    if (modifier === "next") {
      return {
        status: "resolved",
        date: addCalendarDays(today, 7 - today.weekdayIndex + targetWeekday),
      };
    }
    if (modifier === "this") {
      const daysAhead = targetWeekday - today.weekdayIndex;
      if (daysAhead < 0) {
        return {
          status: "clarify",
          message: `This ${capitalize(weekday)} has already passed. Ask whether the caller means next ${capitalize(weekday)}.`,
        };
      }
      return { status: "resolved", date: addCalendarDays(today, daysAhead) };
    }

    const daysAhead = (targetWeekday - today.weekdayIndex + 7) % 7;
    return { status: "resolved", date: addCalendarDays(today, daysAhead) };
  }

  return {
    status: "invalid",
    message:
      "That date phrase is not supported. Ask the caller for a specific date or weekday.",
  };
}

function resolveExplicitDate(
  year: number,
  month: number,
  day: number,
  today: ClinicCalendarDate,
): DateResolution {
  const date = buildCalendarDate(year, month, day);
  if (!date) {
    return {
      status: "invalid",
      message:
        "That calendar date is not valid. Ask the caller for a valid date.",
    };
  }
  if (compareCalendarDates(date, today) < 0) {
    return {
      status: "invalid",
      message:
        "That date has already passed. Ask the caller for a future date.",
    };
  }
  return { status: "resolved", date };
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

function normalizeWhen(value: string): string {
  let normalized = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\b([ap])\s*\.?\s*m\.?/g, "$1m")
    .replace(/[?!,.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  normalized = translateSpanishTemporalPhrase(normalized);
  for (const [alias, weekday] of Object.entries(WEEKDAY_ALIASES)) {
    normalized = replaceWord(normalized, alias, weekday);
  }
  return normalized;
}

function normalizeDatePhrase(value: string): string {
  return value
    .replace(/\b(jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\./g, "$1")
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/g, "$1")
    .replace(
      new RegExp(`\\b(?:the\\s+)?coming\\s+(${WEEKDAY_PATTERN})\\b`),
      "$1",
    )
    .replace(
      new RegExp(`\\bnext\\s+week(?:\\s+on)?\\s+(${WEEKDAY_PATTERN})\\b`),
      "next $1",
    )
    .replace(
      new RegExp(`\\b(${WEEKDAY_PATTERN})\\s+next\\s+week\\b`),
      "next $1",
    )
    .replace(new RegExp(`\\b(${WEEKDAY_PATTERN})'s\\b`), "$1")
    .replace(/\b(?:any\s*time|anytime|whenever)\b/g, " ")
    .replace(/\b(on|for|starting|at)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function translateSpanishTemporalPhrase(value: string): string {
  let translated = value
    .replace(/\bpasado\s+manana\b/g, "day after tomorrow")
    .replace(/\b(?:por|en|de)\s+la\s+manana\b/g, "in the morning")
    .replace(/\b(?:por|en|de)\s+la\s+tarde\b/g, "in the afternoon")
    .replace(/\bla\s+manana\b/g, "morning")
    .replace(/\bla\s+tarde\b/g, "afternoon")
    .replace(/\blo\s+antes\s+posible\b/g, "as soon as possible")
    .replace(
      /\b(?:el\s+)?(?:primer|primero)\s+dia\s+disponible\b/g,
      "next available",
    )
    .replace(/\bdia\s+disponible\b/g, "next available")
    .replace(/\bcualquier\s+dia\b/g, "any day")
    .replace(/\bcualquier\s+hora\b/g, "anytime")
    .replace(/\bprimero\b/g, "1")
    .replace(/\s+o\s+/g, " or ")
    .replace(/\s+y\s+/g, " and ")
    .replace(/\bhoy\b/g, "today")
    .replace(/\bmanana\b/g, "tomorrow")
    .replace(/\ba\s+las\b/g, "at");

  for (const [spanish, english] of Object.entries(SPANISH_WEEKDAY_NAMES)) {
    translated = replaceWord(translated, spanish, english);
  }
  for (const [spanish, english] of Object.entries(SPANISH_MONTH_NAMES)) {
    translated = replaceWord(translated, spanish, english);
  }

  translated = translated
    .replace(new RegExp(`\\beste\\s+(${WEEKDAY_PATTERN})\\b`, "g"), "this $1")
    .replace(/\b(?:la\s+)?proxima\s+semana\b/g, "next week")
    .replace(/\besta\s+semana\b/g, "this week")
    .replace(
      new RegExp(
        `\\b(?:el\\s+)?(\\d{1,2})(?:o|ro)?\\s+de\\s+(${MONTH_PATTERN})(?:\\s+(?:de|del)\\s+(\\d{4}))?\\b`,
        "g",
      ),
      (_, day: string, month: string, year: string | undefined) =>
        `${month} ${day}${year ? ` ${year}` : ""}`,
    )
    .replace(new RegExp(`\\bel\\s+(${WEEKDAY_PATTERN})\\b`, "g"), "$1");
  return translated.replace(/\s+/g, " ").trim();
}

function replaceWord(value: string, word: string, replacement: string): string {
  return value.replace(new RegExp(`\\b${word}\\b`, "g"), replacement);
}

function removeMatch(value: string, match: RegExpMatchArray): string {
  const index = match.index ?? value.indexOf(match[0]);
  return `${value.slice(0, index)} ${value.slice(index + match[0].length)}`;
}

function removeMatchedText(value: string, matchedText: string): string {
  return value.replace(matchedText, " ");
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

function clockMinutes(hour: number, minute: number, meridiem: "am" | "pm") {
  const hour24 =
    meridiem === "am" ? (hour === 12 ? 0 : hour) : hour === 12 ? 12 : hour + 12;
  return hour24 * 60 + minute;
}

function formatClockMinutes(minutes: number): string {
  const hour24 = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const meridiem = hour24 < 12 ? "AM" : "PM";
  const hour = hour24 % 12 || 12;
  return `${hour}:${String(minute).padStart(2, "0")} ${meridiem}`;
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
