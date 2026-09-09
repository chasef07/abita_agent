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
      "billing, separate unfinished appointment work, documentation, optical, medication, referrals including insurance prior authorization, or other.",
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
    .describe("Short staff inbox title naming the caller's request."),
  message: z
    .string()
    .trim()
    .min(1)
    .max(2500)
    .describe(
      "Caller-provided details staff needs. Include medication and pharmacy when known; for prior authorization include patient, plan, visit type, and request.",
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
    "Send safe, non-urgent caller-approved work to staff after collecting the needed details. " +
    "Do not use for completed appointment actions, urgent or clinical concerns, medication guidance or reactions, returned calls, or live-person requests; transfer those when policy requires. " +
    "Call before claiming a message, note, callback, or waitlist request was sent. " +
    "Success confirms staff submission only, without promising approval, completion, refill, or timing.",
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
    const payload = buildStaffTaskPayload(state, office, input);
    const existing = findStaffTaskReceipt(state, payload.idempotencyKey);
    if (existing) {
      return outcomes.reply(
        {
          outcome: "staff_task_duplicate",
          status: "success",
          evidence: { ...existing },
        },
        TASK_DUPLICATE_REPLY,
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
      response.status === "duplicate"
        ? TASK_DUPLICATE_REPLY
        : TASK_CREATED_REPLY,
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
  };
}
