import { describe, expect, it } from "vitest";
import {
  buildCurrentDateTimeMessage,
  get_current_datetime,
} from "../tools/get-current-datetime.js";

describe("get_current_datetime tool", () => {
  it("formats the clinic-local date and time from an instant", () => {
    expect(
      buildCurrentDateTimeMessage(new Date("2026-05-31T14:42:00.000Z")),
    ).toBe("Today is Sunday, May 31st, 2026 at 10:42 AM Eastern time.");
  });

  it("resolves next Wednesday from a Tuesday using clinic-local time", () => {
    expect(
      buildCurrentDateTimeMessage(
        new Date("2026-06-09T14:42:00.000Z"),
        "next Wednesday",
      ),
    ).toBe(
      'Today is Tuesday, June 9th, 2026 at 10:42 AM Eastern time. I interpreted "next Wednesday" as Wednesday, June 10th, 2026. Use 2026-06-10 when checking availability, and confirm that exact date before booking or rescheduling.',
    );
  });

  it("resolves next Wednesday from a Wednesday to the following week", () => {
    expect(
      buildCurrentDateTimeMessage(
        new Date("2026-06-10T14:42:00.000Z"),
        "next Wednesday",
      ),
    ).toContain(
      'I interpreted "next Wednesday" as Wednesday, June 17th, 2026. Use 2026-06-17 when checking availability',
    );
  });

  it("resolves a yearless month and day to the next upcoming date", () => {
    expect(
      buildCurrentDateTimeMessage(
        new Date("2026-06-09T14:42:00.000Z"),
        "June 16",
      ),
    ).toContain(
      'I interpreted "June 16" as Tuesday, June 16th, 2026. Use 2026-06-16 when checking availability',
    );
  });

  it("asks for clarification when a yearless month and day already passed this year", () => {
    expect(
      buildCurrentDateTimeMessage(
        new Date("2026-06-09T14:42:00.000Z"),
        "June 1",
      ),
    ).toContain(
      "June 1st has already passed this year. Ask whether the caller means Tuesday, June 1st, 2027 or another date before checking availability.",
    );
  });

  it("asks for clarification when this weekday has already passed", () => {
    expect(
      buildCurrentDateTimeMessage(
        new Date("2026-06-09T14:42:00.000Z"),
        "this Monday",
      ),
    ).toContain(
      '"This Monday" has already passed this week. Ask whether the caller means Monday, June 15th, 2026 or another date before checking availability.',
    );
  });

  it("asks for clarification for unsupported relative date phrases", () => {
    expect(
      buildCurrentDateTimeMessage(
        new Date("2026-06-09T14:42:00.000Z"),
        "mid next month",
      ),
    ).toContain(
      'I could not safely resolve "mid next month" to one exact date. Ask the caller for a specific date or weekday before checking availability.',
    );
  });

  it("tells the model when to call it", () => {
    expect(get_current_datetime.description).toContain(
      "current clinic-local date and time",
    );
    expect(get_current_datetime.description).toContain(
      "before interpreting relative scheduling dates or times",
    );
    expect(get_current_datetime.description).toContain(
      "Do not call for explicit calendar dates",
    );
    expect(get_current_datetime.description).toContain(
      "returns an exact YYYY-MM-DD date",
    );
  });
});
