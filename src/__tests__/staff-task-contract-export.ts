// Regenerate PHI-free portal fixtures from the real registered tool, with no network.
import { writeFileSync } from "node:fs";
import { isFunctionTool } from "@livekit/agents";
import { buildToolsForTrunk } from "../runtime/tool-registry.js";
import {
  SWEETWATER_OFFICE_PHONE,
  SWEETWATER_TRUNK_PHONES,
} from "../customers/abita/profile.js";
import {
  createConfirmedPatientState,
  confirmedActivePatient,
} from "./support/call-state.js";
import { InMemoryOwnedMiddleware } from "./support/owned-middleware.js";
import { staffTaskCases } from "./support/staff-task-cases.js";
import { captureStaffTaskTransport } from "./support/staff-task-transport.js";

process.env.ACUITY_PRODUCT_HANDOFF_URL =
  "https://staff-task.invalid/v1/handoffs";
process.env.ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET = "synthetic-only";
const transport = captureStaffTaskTransport();
const trunk = SWEETWATER_TRUNK_PHONES[1]!;
const state = createConfirmedPatientState({
  callId: "synthetic-staff-task-444",
  officeKey: "sweetwater",
  amdOfficePhone: SWEETWATER_OFFICE_PHONE,
  callerPhone: "+12025550147",
  trunkPhone: trunk,
  activePatient: confirmedActivePatient({
    patientId: "synthetic-patient-444",
    name: "Alex Example",
    dob: "02/03/1990",
    phone: "+12025550147",
  }),
});
const task = buildToolsForTrunk(
  new InMemoryOwnedMiddleware(),
  trunk,
  transport.fetch,
).find((entry) => isFunctionTool(entry) && entry.name === "create_staff_task");
if (!task || !isFunctionTool(task)) throw new Error("Task not registered");
for (const scenario of staffTaskCases) {
  if (scenario.id === "patient_incomplete")
    state.identity.unresolvedTaskPatient = {};
  await task.execute(
    {
      category: scenario.category,
      urgency: "normal",
      summary: scenario.id.replaceAll("_", " "),
      message: scenario.message,
    },
    {
      ctx: {
        session: { userData: state },
        disallowInterruptions() {},
      } as never,
      toolCallId: scenario.id,
    } as never,
  );
}
const path = new URL(
  "../../evals/fixtures/staff-task-payloads.json",
  import.meta.url,
);
writeFileSync(path, JSON.stringify(transport.payloads, null, 2) + "\n");
console.log(
  `Exported ${transport.payloads.length} synthetic task payloads to evals/fixtures/staff-task-payloads.json`,
);
