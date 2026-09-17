import { isFunctionTool, isToolset, llm } from "@livekit/agents";
import { describe, expect, it } from "vitest";
import { getOfficeProfiles } from "../customers/abita/profile.js";
import { buildToolsForTrunk } from "../runtime/tool-registry.js";
import { check_insurance } from "../tools/check-insurance.js";
import { createSchedulingTools } from "../scheduling/tools.js";
import { createConfirmedPatientState } from "./support/call-state.js";
import { createToolContext } from "./support/tool-context.js";
import { InMemoryOwnedMiddleware } from "./support/owned-middleware.js";

// Every real office and both other demos must retain the original tools.
const unchangedOffices = getOfficeProfiles().filter(
  (office) => office.key !== "new-tampa-demo",
);
const extraTools = ["triage_eye_care", "notify_after_hours_physician"];

describe("New Tampa isolation from other numbers", () => {
  for (const office of unchangedOffices) {
    it.each(office.trunkPhones)(
      `${office.key}: preserves shared tools and availability on %s`,
      async (trunkPhone) => {
        const middleware = new InMemoryOwnedMiddleware({
          getAvailability: [
            {
              dateShifted: false,
              shouldRetrySameSearch: false,
              status: "found",
              requestedDate: "2026-09-08",
              actualDate: "2026-09-08",
              slots: [
                {
                  provider: "Original Office Provider",
                  date: "2026-09-08",
                  time: "9:00 AM",
                  datetime: "2026-09-08T09:00:00-04:00",
                  bookingToken: "test-token",
                },
              ],
            },
          ],
        });
        const registered = buildToolsForTrunk(middleware, trunkPhone).flatMap(
          (entry) => (isToolset(entry) ? entry.tools : [entry]),
        );
        expect(
          registered
            .filter(isFunctionTool)
            .find((entry) => entry.id === "check_insurance"),
        ).toMatchObject({
          id: check_insurance.id,
          description: check_insurance.description,
        });
        expect(
          registered
            .map((entry) => entry.id)
            .filter((id) => extraTools.includes(id)),
        ).toEqual([]);
        const base = createSchedulingTools(middleware, undefined, {
          availabilityOfficeMode:
            office.availabilityOfficeFor().status === "blocked"
              ? "required"
              : "omitted",
        });
        for (const original of Object.values(base)) {
          const actual = registered
            .filter(isFunctionTool)
            .find((entry) => entry.id === original.id)!;
          expect(actual.description).toBe(original.description);
          expect(actual.onDuplicate).toBe(original.onDuplicate);
          expect(llm.toJsonSchema(actual.parameters, true, true)).toEqual(
            llm.toJsonSchema(original.parameters, true, true),
          );
        }
        const visitType = office.schedulingFor("medical").supported
          ? "medical"
          : "routine_vision";
        const state = createConfirmedPatientState({
          officeKey: office.key,
          trunkPhone,
          checkedInsuranceCoverageType: visitType,
          routing: visitType === "medical" ? "all_three" : "optical_only",
        });
        const tool = registered
          .filter(isFunctionTool)
          .find((entry) => entry.id === "list_available_appointments")!;
        const result = await tool.execute(
          {
            visitType,
            ...(office.availabilityOfficeFor().status === "blocked"
              ? { office: office.key }
              : {}),
          },
          {
            ctx: createToolContext(state),
            toolCallId: "isolation-test",
          } as never,
        );
        expect(result).toContain("Original Office Provider");
        expect(result).not.toMatch(/New Tampa|triage_eye_care/);
        expect(state).not.toHaveProperty("newTampaTriage");
      },
    );
  }
});
