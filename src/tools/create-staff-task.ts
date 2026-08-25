import { createHash } from "node:crypto";
import { ToolError, tool } from "@livekit/agents";
import { z } from "zod";
import { getProductTenantConfig } from "../runtime/portal-auth.js";
import {
  activePatientDob,
  activePatientId,
  activePatientName,
  type CallState,
  type StaffTaskCategory,
  type StaffTaskUrgency,
} from "../state/call-state.js";
import {
  findStaffTaskReceipt,
  recordStaffTaskReceipt,
  recordDomainOutcome,
} from "../state/observability.js";
import {
  getOfficeProfileByPhone,
  getProductOfficeKeyByPhone,
  normalizePhoneNumber,
  type OfficeProfile,
} from "../customers/abita/profile.js";
import { getState } from "./session.js";

const TASK_CREATED_REPLY =
  "Task sent to staff. Tell the caller: I wrote that down for the team. They'll review it and follow up.";
const TASK_DUPLICATE_REPLY =
  "Task already sent to staff. Tell the caller: I already sent that to the team. They'll review it and follow up.";
const TASK_FAILED_REPLY =
  "I couldn't send the message. I can transfer you to the office.";

const taskParameters = z.object({
  category: z
    .enum([
      "billing",
      "appointments",
      "documentation",
      "optical",
      "medication",
      "referrals",
      "other",
    ])
    .describe(
      "billing for bills or payments; appointments only for separate appointment-specific work staff still needs to perform, while successful bookings, cancellations, and reschedules are complete; documentation for records or forms; optical for glasses, contacts, lab jobs, or optical orders; medication for routine prescription work; referrals for referral coordination or insurance prior authorization; other for named-person messages or work that fits none of these.",
    ),
  urgency: z
    .enum(["high_priority", "normal", "non_urgent"])
    .describe(
      "Use high_priority for time-sensitive non-clinical work staff should review before normal work, normal for standard follow-up, and non_urgent for work with no time sensitivity. Route clinical acuity through transfer_call.",
    ),
  summary: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .describe("Short staff inbox title naming the caller's request."),
  message: z
    .string()
    .trim()
    .min(1)
    .max(2500)
    .describe(
      "Complete caller-provided request and details staff needs. For medication include the name, requested action, and pharmacy when known; for referrals include the destination or status requested; for insurance prior authorization include the patient, plan, visit type, and authorization request.",
    ),
});

type TaskParameters = z.infer<typeof taskParameters>;

type PortalTaskResponse = {
  status: "created" | "duplicate";
  taskId: string;
  category?: StaffTaskCategory;
  urgency?: StaffTaskUrgency;
};

class StaffTaskDeliveryError extends Error {}

export const create_staff_task = tool({
  name: "create_staff_task",
  description:
    "Use for safe, non-urgent office work that requires staff follow-up. " +
    "Offer to send the request. After the caller agrees, collect the details staff needs, then call create_staff_task. " +
    "Success or duplicate completes the request; reserve a later transfer for a new urgent concern. " +
    "Treat a successful booking, cancellation, or reschedule as complete; use appointments only for separate appointment-specific work staff still needs to perform. " +
    "Use the glasses-readiness text policy for glasses status. Route urgent or clinical concerns, medication reactions or instructions, returned calls, and requests for a person through transfer_call. " +
    "Describe the result as a request sent for staff review, with approval, completion, refill, and timing left open.",
  parameters: taskParameters,
  execute: async (input, { ctx, toolCallId }) => {
    const state = getState(ctx);
    ctx.disallowInterruptions();

    const office = getOfficeProfileByPhone(state.runtime.trunkPhone);
    const payload = buildStaffTaskPayload(state, office, input);
    const existing = findStaffTaskReceipt(state, payload.idempotencyKey);
    if (existing) return TASK_DUPLICATE_REPLY;

    const destination = getStaffTaskDestination(office.key);
    if (!destination) {
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
      if (error instanceof StaffTaskDeliveryError) {
        throw new ToolError(TASK_FAILED_REPLY);
      }
      throw error;
    }
    recordStaffTaskReceipt(state, {
      category: response.category ?? input.category,
      createdAt: new Date().toISOString(),
      idempotencyKey: payload.idempotencyKey,
      message: input.message,
      status: response.status,
      summary: input.summary,
      taskId: response.taskId,
      urgency: response.urgency ?? input.urgency,
    });
    recordDomainOutcome(state, {
      callId: toolCallId,
      toolName: "create_staff_task",
      outcome:
        response.status === "duplicate"
          ? "staff_task_duplicate"
          : "staff_task_created",
      status: "success",
      evidence: {
        category: response.category ?? input.category,
        urgency: response.urgency ?? input.urgency,
      },
    });
    return response.status === "duplicate"
      ? TASK_DUPLICATE_REPLY
      : TASK_CREATED_REPLY;
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
  const officePhone =
    state.office.phoneOverrides[office.key] ?? office.amdOfficePhone;
  const patientId = activePatientId(state);
  const patientName = activePatientName(state);
  const patientDob = activePatientDob(state);
  const patient =
    patientId || patientName || patientDob
      ? {
          ...(patientId ? { id: patientId } : {}),
          ...(patientName ? { name: patientName } : {}),
          ...(patientDob ? { dob: patientDob } : {}),
        }
      : undefined;

  const idempotencyKey = buildIdempotencyKey({
    callId: state.runtime.callId,
    category: input.category,
    message: input.message,
    officePhone,
    patientId,
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
  patientId: string | null;
  summary: string;
}): string {
  const normalized = [
    input.callId,
    normalizePhoneNumber(input.officePhone),
    input.patientId ?? "",
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
    category: parsedBody.category,
    urgency: parsedBody.urgency,
  };
}
