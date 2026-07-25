import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const blockingToolFiles = [
  ["add_patient", "src/tools/add-patient.ts"],
  ["book_appointment", "src/scheduling/tools.ts"],
  ["cancel_appointment", "src/scheduling/tools.ts"],
  ["check_insurance", "src/tools/check-insurance.ts"],
  ["create_staff_task", "src/tools/create-staff-task.ts"],
  ["get_availability", "src/scheduling/tools.ts"],
  ["get_current_datetime", "src/tools/get-current-datetime.ts"],
  ["lookup_knowledge", "src/tools/lookup-knowledge-tool.ts"],
  ["resolve_patient", "src/tools/resolve-patient.ts"],
  ["reschedule_appointment", "src/scheduling/tools.ts"],
  ["transfer_call", "src/tools/transfer-call.ts"],
  ["update_insurance", "src/tools/update-insurance.ts"],
] as const;

describe("tool interruption policy", () => {
  it("classifies every exported LiveKit tool", () => {
    const coveredTools = new Set(
      blockingToolFiles.map(([toolName]) => toolName),
    );
    const toolFiles = readdirSync(resolve(rootDir, "src/tools"))
      .filter((fileName) => fileName.endsWith(".ts"))
      .map((fileName) => resolve(rootDir, "src/tools", fileName));
    toolFiles.push(resolve(rootDir, "src/scheduling/tools.ts"));
    const toolNames = toolFiles
      .flatMap((filePath) => {
        const source = readFileSync(filePath, "utf8");
        return [...source.matchAll(/export const (\w+) = tool\(/g)].map(
          ([, toolName]) => toolName,
        );
      })
      .concat([
        "get_availability",
        "book_appointment",
        "cancel_appointment",
        "reschedule_appointment",
      ]);

    expect(toolNames.sort()).toEqual([...coveredTools].sort());
  });

  it.each(blockingToolFiles)(
    "%s disables interruptions before returning or awaiting tool work",
    (toolName, filePath) => {
      const source = readFileSync(resolve(rootDir, filePath), "utf8");
      const toolIndex = source.indexOf(`name: "${toolName}"`);
      const executeIndex = source.indexOf("execute: async", toolIndex);
      expect(toolIndex).toBeGreaterThanOrEqual(0);
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
