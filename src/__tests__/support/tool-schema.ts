import type { FunctionTool } from "@livekit/agents";
import { z } from "zod";

// LiveKit also accepts JSON and Standard Schema. These tests inspect Zod objects.
export function objectSchema<T extends Parameters<FunctionTool["execute"]>[0]>(
  schema: FunctionTool<T>["parameters"],
) {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error("Expected a Zod object tool schema");
  }
  return schema as z.ZodType<T> & { shape: Record<string, z.ZodType> };
}
