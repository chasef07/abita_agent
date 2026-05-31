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

  it("tells the model when to call it", () => {
    expect(get_current_datetime.description).toContain(
      "current clinic-local date and time",
    );
    expect(get_current_datetime.description).toContain(
      "before interpreting relative dates or times",
    );
    expect(get_current_datetime.description).toContain(
      "returns one short sentence",
    );
    expect(get_current_datetime.description).toContain("read-only");
  });
});
