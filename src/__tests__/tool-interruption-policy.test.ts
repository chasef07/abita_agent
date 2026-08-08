import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const blockingToolFiles = [
  ["add_patient", "src/tools/add-patient.ts", "blocking"],
  ["book_appointment", "src/scheduling/tools.ts", "scoped-write"],
  ["cancel_appointment", "src/scheduling/tools.ts", "scoped-write"],
  ["check_insurance", "src/tools/check-insurance.ts", "blocking"],
  ["create_staff_task", "src/tools/create-staff-task.ts", "blocking"],
  ["get_availability", "src/scheduling/tools.ts", "blocking"],
  ["resolve_patient", "src/tools/resolve-patient.ts", "blocking"],
  ["reschedule_appointment", "src/scheduling/tools.ts", "scoped-write"],
  ["transfer_call", "src/tools/transfer-call.ts", "blocking"],
  ["update_insurance", "src/tools/update-insurance.ts", "blocking"],
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
    (toolName, filePath, interruptionMode) => {
      const source = readFileSync(resolve(rootDir, filePath), "utf8");
      const toolIndex = source.indexOf(`name: "${toolName}"`);
      const executeIndex = source.indexOf("execute: async", toolIndex);
      expect(toolIndex).toBeGreaterThanOrEqual(0);
      expect(executeIndex).toBeGreaterThanOrEqual(0);

      const nextExecuteIndex = source.indexOf(
        "execute: async",
        executeIndex + 1,
      );
      const body = source.slice(
        executeIndex,
        nextExecuteIndex < 0 ? source.length : nextExecuteIndex,
      );
      if (interruptionMode === "scoped-write") {
        expect(body).toMatch(
          /^execute: async[^]*?return runProtectedSchedulingWrite\(ctx,/,
        );
        return;
      }

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

  it("restores scheduling write interruptions after the operation settles", () => {
    const source = readFileSync(
      resolve(rootDir, "src/scheduling/tools.ts"),
      "utf8",
    );
    const helper = source.slice(
      source.indexOf("async function runProtectedSchedulingWrite"),
    );

    expect(helper.indexOf("ctx.disallowInterruptions()")).toBeLessThan(
      helper.indexOf("await operation()"),
    );
    expect(helper).toContain("finally");
    expect(helper).toContain("speechHandle.allowInterruptions =");
  });
});

function firstIndexOf(source: string, tokens: readonly string[]): number {
  return Math.min(
    ...tokens
      .map((token) => source.indexOf(token))
      .filter((index) => index >= 0),
  );
}
