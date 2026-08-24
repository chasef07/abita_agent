import { isToolset, llm } from "@livekit/agents";
import { describe, expect, it } from "vitest";
import {
  CRYSTAL_RIVER_OFFICE_PHONE,
  HOLLYWOOD_OFFICE_PHONE,
  MENTAL_HEALTH_DEMO_TRUNK_PHONE,
  NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
  OPHTHALMOLOGY_DEMO_TRUNK_PHONE,
  RHEUMATOLOGY_DEMO_TRUNK_PHONE,
  SPRING_HILL_OFFICE_PHONE,
  SWEETWATER_OFFICE_PHONE,
} from "../customers/abita/profile.js";
import { buildToolsForTrunk } from "../runtime/tool-registry.js";

const OFFICE_TRUNKS = [
  SPRING_HILL_OFFICE_PHONE,
  CRYSTAL_RIVER_OFFICE_PHONE,
  HOLLYWOOD_OFFICE_PHONE,
  SWEETWATER_OFFICE_PHONE,
  NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
  OPHTHALMOLOGY_DEMO_TRUNK_PHONE,
  MENTAL_HEALTH_DEMO_TRUNK_PHONE,
  RHEUMATOLOGY_DEMO_TRUNK_PHONE,
] as const;

describe("strict tool schemas", () => {
  it.each(OFFICE_TRUNKS)(
    "emits strict-compatible schemas for the tools registered on %s",
    (trunkPhone) => {
      const invalidSchemas = buildToolsForTrunk(trunkPhone).flatMap((entry) =>
        (isToolset(entry) ? entry.tools : [entry]).flatMap((registeredTool) => {
          try {
            llm.toJsonSchema(registeredTool.parameters, true, true);
            return [];
          } catch (error) {
            return [
              {
                error: error instanceof Error ? error.message : String(error),
                tool: registeredTool.id,
              },
            ];
          }
        }),
      );

      expect(invalidSchemas).toEqual([]);
    },
  );
});
