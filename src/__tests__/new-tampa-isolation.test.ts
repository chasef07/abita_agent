import { isToolset, llm } from "@livekit/agents";
import { describe, expect, it } from "vitest";
import { getOfficeProfiles } from "../customers/abita/profile.js";
import { buildToolsForTrunk } from "../runtime/tool-registry.js";
import { check_insurance } from "../tools/check-insurance.js";
import { createSchedulingTools } from "../scheduling/tools.js";
import { bindSchedulingMiddleware } from "../scheduling/middleware.js";
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
        expect(registered.find((entry) => entry.id === "check_insurance")).toBe(
          check_insurance,
        );
        expect(
          registered
            .map((entry) => entry.id)
            .filter((id) => extraTools.includes(id)),
        ).toEqual([]);
        const base = createSchedulingTools(
          bindSchedulingMiddleware(middleware),
          undefined,
          {
            availabilityOfficeMode:
              office.availabilityOfficeFor().status === "blocked"
                ? "required"
                : "omitted",
          },
        );
        for (const original of Object.values(base)) {
          const actual = registered.find((entry) => entry.id === original.id)!;
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
          amdOfficePhone: office.amdOfficePhone,
          checkedInsuranceCoverageType: visitType,
          routing: visitType === "medical" ? "all_three" : "optical_only",
        });
        const tool = registered.find(
          (entry) => entry.id === "list_available_appointments",
        )!;
        const result = await tool.execute(
          {
            range: "default",
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
