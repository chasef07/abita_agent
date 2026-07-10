import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const blockingToolFiles = [
  ["add_patient", "src/tools/add-patient.ts"],
  ["book_appointment", "src/tools/book-appt.ts"],
  ["cancel_appointment", "src/tools/cancel-appt.ts"],
  ["check_insurance", "src/tools/check-insurance.ts"],
  ["create_staff_task", "src/tools/create-staff-task.ts"],
  ["get_availability", "src/tools/get-availability.ts"],
  ["get_current_datetime", "src/tools/get-current-datetime.ts"],
  ["lookup_knowledge", "src/tools/lookup-knowledge-tool.ts"],
  ["resolve_patient", "src/tools/resolve-patient.ts"],
  ["reschedule_appointment", "src/tools/reschedule-appt.ts"],
  ["transfer_call", "src/tools/transfer-call.ts"],
  ["update_insurance", "src/tools/update-insurance.ts"],
] as const;

describe("tool interruption policy", () => {
  it("classifies every exported LiveKit tool", () => {
    const coveredTools = new Set(
      blockingToolFiles.map(([toolName]) => toolName),
    );
    const toolNames = readdirSync(resolve(rootDir, "src/tools"))
      .filter((fileName) => fileName.endsWith(".ts"))
      .flatMap((fileName) => {
        const source = readFileSync(
          resolve(rootDir, "src/tools", fileName),
          "utf8",
        );
        return [...source.matchAll(/export const (\w+) = tool\(/g)].map(
          ([, toolName]) => toolName,
        );
      });

    expect(toolNames.sort()).toEqual([...coveredTools].sort());
  });

  it.each(blockingToolFiles)(
    "%s disables interruptions before returning or awaiting tool work",
    (_toolName, filePath) => {
      const source = readFileSync(resolve(rootDir, filePath), "utf8");
      const executeIndex = source.indexOf("execute: async");
      expect(executeIndex).toBeGreaterThanOrEqual(0);

      const body = source.slice(executeIndex);
      const disallowIndex = body.indexOf("ctx.disallowInterruptions()");
      expect(disallowIndex).toBeGreaterThanOrEqual(0);

      const firstOrphanableStep = firstIndexOf(body, [
        "if (",
        "return ",
        "throw ",
        "await ",
        "callApi(",
        "ctx.update(",
        "ctx.waitForPlayout(",
      ]);
      expect(firstOrphanableStep).toBeGreaterThanOrEqual(0);
      expect(disallowIndex).toBeLessThan(firstOrphanableStep);
    },
  );
});

function firstIndexOf(source: string, tokens: readonly string[]): number {
  return Math.min(
    ...tokens
      .map((token) => source.indexOf(token))
      .filter((index) => index >= 0),
  );
}
