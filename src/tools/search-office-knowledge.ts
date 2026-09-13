import { tool, type ToolOptions } from "@livekit/agents";
import { z } from "zod";
import {
  activeOfficeKey,
  officeContextSignal,
} from "../state/call-lifecycle.js";
import { getProductTenantConfig } from "../runtime/portal-auth.js";
import { getState } from "./session.js";

const passage = z.object({
  revisionId: z.string().min(1).max(100),
  sectionId: z.string().min(1).max(100),
  title: z.string().min(1).max(200),
  text: z.string().min(1).max(12000),
});
const searchResponse = z
  .object({
    outcome: z.enum(["found", "no_relevant_information", "temporary_failure"]),
    revisionId: z.string().min(1).max(100).optional(),
    passages: z.array(passage).max(8),
  })
  .superRefine((value, ctx) => {
    if (
      value.outcome === "found" &&
      (!value.revisionId ||
        value.passages.length === 0 ||
        value.passages.some((p) => p.revisionId !== value.revisionId))
    )
      ctx.addIssue({ code: "custom", message: "Incomplete or mixed revision" });
    if (value.outcome !== "found" && value.passages.length > 0)
      ctx.addIssue({ code: "custom", message: "Unexpected passages" });
  });
const parameters = z
  .object({
    query: z
      .string()
      .trim()
      .min(3)
      .max(500)
      .describe(
        "A short non-patient question about this office. Omit patient names, identifiers, and personal medical details.",
      ),
  })
  .strict();
const unavailable = "Office knowledge is temporarily unavailable.";
const noInformation =
  "No relevant office information was found for this question.";

export function createSearchOfficeKnowledgeTool() {
  return tool({
    name: "search_office_knowledge",
    description:
      "Searches the office knowledge base for practice-specific information such as providers, hours, location, and policies. Always call this tool for practice-related knowledge questions.",
    parameters,
    execute: async (
      { query }: z.infer<typeof parameters>,
      { ctx, abortSignal }: ToolOptions,
    ): Promise<string> => {
      const state = getState(ctx);
      const officeKey = activeOfficeKey(state);
      const signal = AbortSignal.any([
        abortSignal,
        officeContextSignal(state),
        AbortSignal.timeout(4000),
      ]);
      try {
        const url = process.env.ACUITY_PRODUCT_KNOWLEDGE_URL?.trim();
        const { secret } = getProductTenantConfig(officeKey);
        // Defense in depth for common identifiers, not a complete patient-data filter.
        const includesIdentifier =
          /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|\b\d{1,4}[/-]\d{1,2}[/-]\d{2,4}\b|(?:\+?\d[\s().-]*){7,}/i.test(
            query,
          );
        if (
          !url ||
          !secret ||
          includesIdentifier ||
          !parameters.safeParse({ query }).success
        )
          return unavailable;
        const endpoint = new URL(url);
        if (
          endpoint.protocol !== "https:" &&
          !(
            endpoint.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
          )
        )
          return unavailable;
        signal.throwIfAborted();
        const response = await fetch(endpoint.href, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json",
            "X-Office-Key": officeKey,
          },
          body: JSON.stringify({ query }),
        });
        if (!response.ok) throw new Error("Knowledge unavailable");
        const parsed = searchResponse.parse(await response.json());
        signal.throwIfAborted();
        if (activeOfficeKey(state) !== officeKey)
          throw new Error("Office changed");
        if (parsed.outcome === "temporary_failure") return unavailable;
        if (parsed.outcome === "no_relevant_information") return noInformation;
        const answer = parsed.passages
          .map((passage) =>
            passage.text
              .replace(
                /^Status:\s*(?:available|not-supplied|not-offered)\s*(?:\r?\n|$)/i,
                "",
              )
              .trim(),
          )
          .join("\n");
        return answer.trim() ? answer : unavailable;
      } catch {
        return unavailable;
      }
    },
  });
}
