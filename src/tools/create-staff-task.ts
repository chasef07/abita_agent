import { createHash } from "node:crypto";
import { tool } from "@livekit/agents";
import { z } from "zod";
import { getAnalyticsSecret } from "../runtime/portal-auth.js";
import { activeOfficeKey } from "../state/call-lifecycle.js";
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
} from "../state/observability.js";
import {
  getOfficeProfile,
  normalizePhoneNumber,
} from "../customers/abita/profile.js";
import { getState } from "./session.js";

const TASK_CREATED_REPLY =
  "Task sent to staff. Tell the caller: I wrote that down for the team. They'll review it and follow up.";
const TASK_DUPLICATE_REPLY =
  "Task already sent to staff. Tell the caller: I already sent that to the team. They'll review it and follow up.";
const TASK_FAILED_REPLY =
  "Could not send the staff task. Tell the caller: I couldn't send that message, but I can transfer you to the office.";

const taskParameters = z.object({
  category: z.enum([
    "billing",
    "appointments",
    "documentation",
    "optical",
    "medication",
    "referrals",
    "other",
  ]),
  urgency: z.enum(["high_priority", "normal", "non_urgent"]),
  summary: z.string().trim().min(1).max(240),
  message: z.string().trim().min(1).max(2500),
});

type TaskParameters = z.infer<typeof taskParameters>;

type PortalTaskResponse = {
  status: "created" | "duplicate";
  taskId: string;
  category?: StaffTaskCategory;
  urgency?: StaffTaskUrgency;
};

export const create_staff_task = tool({
  name: "create_staff_task",
  description:
    "Create a staff follow-up task for the current office after gathering what the caller needs the team to do, check, send, update, answer, or review. " +
    "Use this only for safe non-live office work the agent cannot complete, such as billing questions, appointment issues, documentation/forms/records requests, optical order issues other than a simple glasses-readiness check, named-person messages, or routine medication and prescription requests that staff can review asynchronously, including refills, status checks, and pharmacy updates. " +
    "Before calling, ask what exactly the caller needs the team to know if the request is vague. " +
    "Use category optical for glasses, contacts, lab jobs, or optical order issues. Use category medication for routine medication or prescription work and include the medication or prescription name, requested action, and pharmacy name or location when the caller knows them. Use category referrals for referral receipt, status, destination, or coordination; keep records and forms in category documentation. Do not promise approval, a refill, or a completion time. " +
    "Do not call for emergency or urgent symptoms, suspected medication reactions, new or worsening medical concerns, dosage or medication instructions, clinical advice, medical decisions, returned calls, or callers who still insist on a live human now. Transfer those instead. " +
    "Use high_priority only for non-clinical office follow-up that should be reviewed before normal work; never use it for clinical acuity.",
  parameters: taskParameters,
  execute: async (input, { ctx }) => {
    const state = getState(ctx);
    ctx.disallowInterruptions();

    const payload = buildStaffTaskPayload(state, input);
    const existing = findStaffTaskReceipt(state, payload.idempotencyKey);
    if (existing) return TASK_DUPLICATE_REPLY;

    const url = getStaffTasksUrl();
    const secret = getAnalyticsSecret();
    if (!url || !secret) return TASK_FAILED_REPLY;

    try {
      const response = await postStaffTask(url, secret, payload);
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
      return response.status === "duplicate"
        ? TASK_DUPLICATE_REPLY
        : TASK_CREATED_REPLY;
    } catch (error) {
      console.error("[tools] Staff task POST failed:", error);
      return TASK_FAILED_REPLY;
    }
  },
});

export function getStaffTasksUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicit = env.STAFF_TASKS_URL?.trim();
  if (explicit) return explicit;

  const analyticsUrl = env.ANALYTICS_URL?.trim();
  if (!analyticsUrl) return undefined;

  return analyticsUrl.replace(/\/calls\/?$/, "/tasks");
}

function buildStaffTaskPayload(state: CallState, input: TaskParameters) {
  const officeKey = activeOfficeKey(state);
  const office = getOfficeProfile(officeKey);
  const officePhone =
    state.office.phoneOverrides[officeKey] ?? office.amdOfficePhone;
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
    callerPhone: state.runtime.callerPhone,
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
  const response = await fetch(url, {
    body: JSON.stringify(payload),
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

  if (!response.ok) {
    throw new Error(`Staff task POST returned ${response.status}`);
  }

  const body = (await response.json()) as Partial<PortalTaskResponse>;
  if (
    (body.status !== "created" && body.status !== "duplicate") ||
    !body.taskId
  ) {
    throw new Error("Staff task POST returned an invalid response");
  }

  return {
    status: body.status,
    taskId: body.taskId,
    category: body.category,
    urgency: body.urgency,
  };
}
