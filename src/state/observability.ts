import type {
  AppointmentActionAnalytics,
  AvailabilityReadAnalytics,
  CallState,
  OfficeKnowledgeRetrievalAnalytics,
  StaffTaskReceipt,
  DomainOutcomeReceipt,
} from "./call-state.js";

export function recordDomainOutcome(
  state: CallState,
  receipt: Omit<DomainOutcomeReceipt, "occurredAt"> & { occurredAt?: string },
): void {
  const complete = { occurredAt: new Date().toISOString(), ...receipt };
  const index = state.runtime.outcomeReceipts.findIndex(
    (item) => item.callId === complete.callId,
  );
  if (index === -1) state.runtime.outcomeReceipts.push(complete);
  else state.runtime.outcomeReceipts[index] = complete;
}

type ToolDomainOutcome = Omit<
  DomainOutcomeReceipt,
  "callId" | "toolName" | "occurredAt"
> & { occurredAt?: string };

/** Bind invariant LiveKit tool identity once, then record only domain facts. */
export function domainOutcomesForTool(
  state: CallState,
  callId: string,
  toolName: string,
) {
  const record = (outcome: ToolDomainOutcome) =>
    recordDomainOutcome(state, { ...outcome, callId, toolName });
  return {
    record,
    reply(outcome: ToolDomainOutcome, reply: string) {
      record(outcome);
      return reply;
    },
  };
}

export function domainOutcomeReceipts(
  state: CallState,
): DomainOutcomeReceipt[] {
  return [...state.runtime.outcomeReceipts];
}

const MAX_OFFICE_KNOWLEDGE_RETRIEVALS = 200;

export function recordOfficeKnowledgeRetrieval(
  state: CallState,
  retrieval: Omit<OfficeKnowledgeRetrievalAnalytics, "createdAt">,
): void {
  state.runtime.knowledgeRetrievals = [
    ...state.runtime.knowledgeRetrievals,
    {
      createdAt: new Date().toISOString(),
      ...retrieval,
    },
  ].slice(-MAX_OFFICE_KNOWLEDGE_RETRIEVALS);
}

export function recordAppointmentAction(
  state: CallState,
  callId: string,
  action: AppointmentActionAnalytics,
  options: { replayed?: boolean } = {},
): void {
  const stableAction = { ...action };
  delete stableAction.message;
  const complete = {
    ...stableAction,
    createdAt: new Date().toISOString(),
    ...(options.replayed ? { replayed: true } : {}),
  };
  recordDomainOutcome(state, {
    callId,
    toolName:
      action.toolName ??
      (action.action === "booked"
        ? "book_appointment"
        : action.action === "cancelled"
          ? "cancel_appointment"
          : "reschedule_appointment"),
    outcome: action.action,
    status:
      action.status === "error"
        ? "failed"
        : action.status === "partial"
          ? "partial"
          : "success",
    evidence: complete as unknown as Record<string, unknown>,
  });
}

export function appointmentActions(
  state: CallState,
): AppointmentActionAnalytics[] {
  return domainOutcomeReceipts(state)
    .filter(
      (receipt) =>
        ["booked", "cancelled", "rescheduled"].includes(receipt.outcome) &&
        receipt.evidence?.replayed !== true,
    )
    .flatMap((receipt) =>
      receipt.evidence
        ? [receipt.evidence as unknown as AppointmentActionAnalytics]
        : [],
    );
}

export function recordAvailabilityReadEvent(
  state: CallState,
  event: AvailabilityReadAnalytics,
): void {
  state.runtime.availabilityReads = [
    ...state.runtime.availabilityReads,
    {
      createdAt: new Date().toISOString(),
      ...event,
    },
  ];
}

export function availabilityReadEvents(
  state: CallState,
): AvailabilityReadAnalytics[] {
  return [...state.runtime.availabilityReads];
}

export function staffTaskReceipts(state: CallState): StaffTaskReceipt[] {
  return [...state.runtime.staffTasks];
}

export function findStaffTaskReceipt(
  state: CallState,
  idempotencyKey: string,
): StaffTaskReceipt | null {
  return (
    state.runtime.staffTasks.find(
      (receipt) => receipt.idempotencyKey === idempotencyKey,
    ) ?? null
  );
}

export function recordStaffTaskReceipt(
  state: CallState,
  receipt: StaffTaskReceipt,
): void {
  state.runtime.staffTasks = [
    ...state.runtime.staffTasks.filter(
      (item) => item.idempotencyKey !== receipt.idempotencyKey,
    ),
    receipt,
  ];
}
