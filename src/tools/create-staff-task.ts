import { createHash } from "node:crypto";
import { ToolError, tool } from "@livekit/agents";
import { z } from "zod";
import { staffTaskPatient } from "../identity/patient-identity.js";
import { getProductTenantConfig } from "../runtime/portal-auth.js";
import {
  type CallState,
  type StaffTaskCategory,
  STAFF_TASK_CATEGORIES,
} from "../state/call-state.js";
import {
  domainOutcomesForTool,
  findStaffTaskReceipt,
  recordStaffTaskReceipt,
} from "../state/observability.js";
import {
  getOfficeProfileByPhone,
  getProductOfficeKeyByPhone,
  normalizePhoneNumber,
  type OfficeProfile,
} from "../customers/abita/profile.js";
import { getState } from "./session.js";
import { usesSandboxMiddleware } from "../runtime/middleware-routing.js";

const TASK_CREATED_REPLY =
  "I wrote that down for the team. They'll review it and follow up.";
const TASK_DUPLICATE_REPLY =
  "I already sent that to the team. They'll review it and follow up.";
const TASK_FAILED_REPLY =
  "I couldn't send the message. I can transfer you to the office.";

const taskParameters = z.object({
  category: z
    .enum(STAFF_TASK_CATEGORIES)
    .describe(
      "optical includes glasses/contact prescriptions; medication includes refills and medication authorizations; " +
        "insurance includes copays, coverage, referral requirements and service authorizations; referrals means specialist/imaging orders. " +
        "pre_op/post_op mean surgical preparation/aftercare, not scheduling, refills or authorizations. " +
        "For prior authorization, ask what it authorizes if unknown. If the caller still cannot specify medication versus service, category MUST be other, never insurance. " +
        "Use other for any request still unclear after clarification.",
    ),
  urgency: z
    .enum(["high_priority", "normal", "non_urgent"])
    .describe(
      "high_priority for time-sensitive non-clinical work; normal for standard follow-up; non_urgent with no time sensitivity. Transfer clinical acuity.",
    ),
  summary: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .describe("Short staff inbox title for one unresolved need."),
  message: z
    .string()
    .trim()
    .min(1)
    .max(2500)
    .describe(
      "Details of exactly ONE need for this patient; make another tool call for each additional need, even with the same category. " +
        "Include medication/pharmacy, service/plan, authorization status and procedure timing when relevant. Preserve essential intake and list missing details.",
    ),
});

type TaskParameters = z.infer<typeof taskParameters>;

type PortalTaskResponse = {
  status: "created" | "duplicate";
  taskId: string;
};

class StaffTaskDeliveryError extends Error {}

export const create_staff_task = tool({
  name: "create_staff_task",
  description:
    "Send one safe, non-urgent caller-approved unresolved request per invocation. Submit distinct needs separately, even within one category. " +
    "For records, search office knowledge for intake and delivery rules; speak restrictions and missing prerequisites even when already approved. " +
    "Collect details; list gaps if incomplete. Follow Human Transfer policy for urgent or clinical concerns. " +
    "Confirm submission only after success; staff owns fulfillment and timing.",
  parameters: taskParameters,
  execute: async (input, { ctx, toolCallId }): Promise<string> => {
    const state = getState(ctx);
    ctx.disallowInterruptions();
    const outcomes = domainOutcomesForTool(
      state,
      toolCallId,
      "create_staff_task",
    );
    const office = getOfficeProfileByPhone(state.runtime.trunkPhone);
    if (usesSandboxMiddleware(office.key)) {
      return outcomes.reply(
        { outcome: "staff_task_failed", status: "blocked" },
        "Staff tasks are unavailable in this sandbox call. No message was sent; do not promise staff follow-up.",
      );
    }
    const validated = taskParameters.safeParse(input);
    if (!validated.success) {
      outcomes.record({ outcome: "staff_task_failed", status: "blocked" });
      throw new ToolError(
        "No request was sent. Use a supported non-billing category, a summary up to 240 characters and a message up to 2500 characters. Condense wording without losing collected details or missing prerequisites, then retry. Never silently truncate essential intake.",
      );
    }
    const payload = buildStaffTaskPayload(state, office, validated.data);
    const existing = findStaffTaskReceipt(state, payload.idempotencyKey);
    if (existing) {
      return outcomes.reply(
        {
          outcome: "staff_task_duplicate",
          status: "success",
          evidence: { ...existing },
        },
        staffTaskReply(TASK_DUPLICATE_REPLY, existing.taskId),
      );
    }

    const destination = getStaffTaskDestination(office.key);
    if (!destination) {
      outcomes.record({ outcome: "staff_task_failed", status: "failed" });
      throw new Error("Staff task delivery is not configured.");
    }

    let response: PortalTaskResponse;
    try {
      response = await postStaffTask(
        destination.url,
        destination.secret,
        payload,
      );
    } catch (error) {
      console.error("[tools] Staff task POST failed:", error);
      outcomes.record({ outcome: "staff_task_failed", status: "failed" });
      if (error instanceof StaffTaskDeliveryError) {
        throw new ToolError(TASK_FAILED_REPLY);
      }
      throw error;
    }
    const receipt = {
      createdAt: new Date().toISOString(),
      idempotencyKey: payload.idempotencyKey,
      status: response.status,
      taskId: response.taskId,
    };
    recordStaffTaskReceipt(state, receipt);
    return outcomes.reply(
      {
        outcome:
          response.status === "duplicate"
            ? "staff_task_duplicate"
            : "staff_task_created",
        status: "success",
        evidence: receipt,
      },
      staffTaskReply(
        response.status === "duplicate"
          ? TASK_DUPLICATE_REPLY
          : TASK_CREATED_REPLY,
        response.taskId,
      ),
    );
  },
});

export function getAcuityProductStaffTasksUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const handoffUrl = env.ACUITY_PRODUCT_HANDOFF_URL?.trim();
  if (!handoffUrl) return undefined;

  const tasksUrl = handoffUrl.replace(/\/v1\/handoffs\/?$/, "/v1/tasks");
  return tasksUrl === handoffUrl ? undefined : tasksUrl;
}

function getStaffTaskDestination(
  officeKey: OfficeProfile["key"],
  env: NodeJS.ProcessEnv = process.env,
): { secret: string; url: string } | null {
  const url = getAcuityProductStaffTasksUrl(env);
  const secret = getProductTenantConfig(officeKey, env).secret;
  return url && secret ? { secret, url } : null;
}

function buildStaffTaskPayload(
  state: CallState,
  office: OfficeProfile,
  input: TaskParameters,
) {
  const officeKey = getProductOfficeKeyByPhone(state.runtime.trunkPhone);
  const officePhone = office.amdOfficePhone;
  const patient = staffTaskPatient(state);

  const idempotencyKey = buildIdempotencyKey({
    callId: state.runtime.callId,
    category: input.category,
    message: input.message,
    officePhone,
    patientIdentity: patient?.id ?? JSON.stringify(patient ?? {}),
    summary: input.summary,
  });

  return {
    callId: state.runtime.callId,
    callerPhone: normalizePhoneNumber(state.runtime.callerPhone),
    category: input.category,
    idempotencyKey,
    ...(normalizePhoneNumber(state.runtime.trunkPhone) !==
    normalizePhoneNumber(officePhone)
      ? { inboundOfficePhone: state.runtime.trunkPhone }
      : {}),
    message: input.message,
    officeKey,
    officePhone,
    patient,
    source: "agent" as const,
    summary: input.summary,
    urgency: input.urgency,
  };
}

function buildIdempotencyKey(input: {
  callId: string;
  category: StaffTaskCategory;
  message: string;
  officePhone: string;
  patientIdentity: string;
  summary: string;
}): string {
  const normalized = [
    input.callId,
    normalizePhoneNumber(input.officePhone),
    input.patientIdentity,
    input.category,
    normalizeText(input.summary),
    normalizeText(input.message),
  ].join("|");
  return `staff_task_${createHash("sha256").update(normalized).digest("hex")}`;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

async function postStaffTask(
  url: string,
  secret: string,
  payload: ReturnType<typeof buildStaffTaskPayload>,
): Promise<PortalTaskResponse> {
  const body = JSON.stringify(payload);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await postStaffTaskOnce(url, secret, body);
    } catch (error) {
      if (!(error instanceof StaffTaskDeliveryError) || attempt === 1) {
        throw error;
      }
    }
  }

  throw new StaffTaskDeliveryError("Staff task POST failed");
}

async function postStaffTaskOnce(
  url: string,
  secret: string,
  body: string,
): Promise<PortalTaskResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      body,
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal:
        typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(10_000)
          : undefined,
    });
  } catch {
    throw new StaffTaskDeliveryError("Staff task POST failed");
  }

  if (!response.ok) {
    const message = `Staff task POST returned ${response.status}`;
    if (
      response.status === 408 ||
      response.status === 429 ||
      (response.status >= 500 && response.status <= 599)
    ) {
      throw new StaffTaskDeliveryError(message);
    }
    throw new Error(message);
  }

  let parsedBody: Partial<PortalTaskResponse>;
  try {
    parsedBody = (await response.json()) as Partial<PortalTaskResponse>;
  } catch {
    throw new StaffTaskDeliveryError(
      "Staff task POST response could not be read",
    );
  }
  if (
    (parsedBody.status !== "created" && parsedBody.status !== "duplicate") ||
    !parsedBody.taskId
  ) {
    throw new Error("Staff task POST returned an invalid response");
  }

  return {
    status: parsedBody.status,
    taskId: parsedBody.taskId,
  };
}

function staffTaskReply(reply: string, taskId: string): string {
  return `${reply}\nInternal Task reference (do not read aloud): ${taskId}. If transferring this same request, pass this as taskId to transfer_call.`;
}
