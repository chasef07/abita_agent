import type { CallFlowState, WorkflowCommand } from "./types.js";

export interface FlowContextDirectives {
  currentObjective: string;
  allowedActions: string[];
  blockedActions: string[];
  nextAction?: string;
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

export function directivesForFlowState(
  flow: CallFlowState,
): FlowContextDirectives {
  switch (flow.step) {
    case "triage_visit_type":
      return {
        currentObjective:
          "Find out what the caller needs to be seen for before checking insurance or scheduling.",
        allowedActions: ["ask_visit_reason", "prepareSchedulingPath"],
        blockedActions: [
          "check_insurance",
          "add_patient",
          "get_availability",
          "book_appt",
          "cancel_appt",
        ],
      };
    case "check_insurance":
      return {
        currentObjective:
          "Collect the exact insurance plan and check the right coverage type.",
        allowedActions: [
          "ask_insurance_plan",
          "check_insurance",
          "prepareSchedulingPath",
        ],
        blockedActions: [
          "add_patient",
          "get_availability",
          "book_appt",
          "cancel_appt",
        ],
      };
    case "route_office":
      return {
        currentObjective:
          "Explain the office routing and get agreement before switching the active workflow.",
        allowedActions: [
          "explain_routing",
          "route_to_spring_hill",
          "prepareSchedulingPath",
        ],
        blockedActions: ["transfer_call", "get_availability", "book_appt"],
      };
    case "verify_patient":
      return {
        currentObjective:
          "Verify the patient before using patient or scheduling tools.",
        allowedActions: ["ask_patient_name", "ask_dob", "verify_patient"],
        blockedActions: ["add_patient", "get_availability", "book_appt"],
      };
    case "collect_registration":
      return {
        currentObjective:
          "Collect only the missing registration fields, then read back the required fields before submitting.",
        allowedActions: ["ask_missing_registration_field", "add_patient"],
        blockedActions: ["get_availability", "book_appt", "cancel_appt"],
      };
    case "get_availability":
      return {
        currentObjective:
          "Search availability for the right routing lane and offer one best-fit slot.",
        allowedActions: ["ask_preferred_date", "get_availability"],
        blockedActions: ["book_appt", "cancel_appt"],
      };
    case "confirm_booking":
      return {
        currentObjective:
          "Confirm the exact appointment slot before booking it.",
        allowedActions: ["ask_booking_confirmation", "book_appt"],
        blockedActions: ["cancel_appt", "transfer_call"],
      };
    case "confirm_cancel":
      return {
        currentObjective:
          "Confirm the caller wants to cancel the specific appointment before cancelling.",
        allowedActions: ["ask_cancel_confirmation", "cancel_appt"],
        blockedActions: ["book_appt"],
      };
    case "handoff":
      return {
        currentObjective:
          "Confirm the caller should be transferred before starting the handoff.",
        allowedActions: ["transfer_call"],
        blockedActions: ["book_appt", "cancel_appt"],
      };
    default:
      return {
        currentObjective:
          "Understand the caller's intent and choose the safest next step.",
        allowedActions: ["ask_clarifying_question", "lookup_knowledge"],
        blockedActions: ["add_patient", "get_availability", "book_appt"],
      };
  }
}

export function compileFlowContextPacket(
  flow: CallFlowState,
  overrides: Partial<FlowContextDirectives> = {},
): string {
  const directives = {
    ...directivesForFlowState(flow),
    ...overrides,
  };

  return [
    "<flow_state>",
    `activeFlow: ${flow.activeFlow}`,
    `activeIntent: ${flow.activeIntent ?? "unknown"}`,
    `step: ${flow.step}`,
    `language: ${flow.language}`,
    `activePatient: ${flow.activePatientRef ?? "unknown"}`,
    `patientStatus: ${flow.patientStatus}`,
    `office: ${flow.officeKey}`,
    `visitType: ${flow.visitType ?? "unknown"}`,
    `coverageType: ${flow.coverageType ?? "unknown"}`,
    `routing: ${flow.routing ?? "unknown"}`,
    `schedulingGoal: ${formatSchedulingGoal(flow)}`,
    `task: ${flow.currentTask?.kind ?? flow.activeFlow}`,
    `pendingActions: ${flow.pendingActions.length}`,
    `availabilitySearches: ${flow.availabilitySearches.length}`,
    `missingSlots: ${formatList(flow.requiredSlots)}`,
    `completedSteps: ${formatList(flow.completedSteps)}`,
    `allowedActions: ${formatList(directives.allowedActions)}`,
    `blockedActions: ${formatList(directives.blockedActions)}`,
    "</flow_state>",
    "",
    "<current_objective>",
    directives.currentObjective,
    "</current_objective>",
  ].join("\n");
}

export function compileTurnStatePacket(
  flow: CallFlowState,
  overrides: Partial<FlowContextDirectives> = {},
): string {
  const workflowCommand = activeWorkflowCommand(flow);
  if (workflowCommand) {
    return compileWorkflowTurnStatePacket(flow, workflowCommand);
  }

  const directives = {
    ...directivesForFlowState(flow),
    ...overrides,
  };

  return [
    "<turn_state>",
    `intent: ${flow.activeIntent ?? "unclear"}`,
    `activePatient: ${flow.activePatientRef ?? "unknown"}`,
    `patientStatus: ${formatPatientStatus(flow)}`,
    `task: ${flow.currentTask?.kind ?? flow.activeFlow}`,
    `step: ${flow.step}`,
    `visitType: ${flow.visitType ?? "unknown"}`,
    `scheduling: ${formatSchedulingGoal(flow)}`,
    `office: ${flow.officeKey}`,
    `nextAction: ${directives.nextAction ?? directives.allowedActions[0] ?? "continue"}`,
    `blockedActions: ${formatList(directives.blockedActions)}`,
    "</turn_state>",
    "",
    compileContextCapsules(flow, directives),
  ].join("\n");
}

function activeWorkflowCommand(
  flow: CallFlowState,
): WorkflowCommand | undefined {
  const command = flow.lastWorkflowCommand;
  if (!command || command.commandSource !== "task_plan") return undefined;
  if (flow.activeTaskPlanId && command.taskId !== flow.activeTaskPlanId) {
    return undefined;
  }
  return command;
}

function compileWorkflowTurnStatePacket(
  flow: CallFlowState,
  command: WorkflowCommand,
): string {
  const nextSafeAction =
    command.nextAction === "call_tool" && command.tool
      ? `call_tool ${command.tool}`
      : command.nextAction;

  return [
    "<turn_state>",
    `task: ${command.taskKind}`,
    `taskId: ${command.taskId}`,
    `patient: ${flow.activePatientRef ?? command.patientRef ?? "unknown"} ${formatPatientStatus(flow)}`,
    `patientStatus: ${formatPatientStatus(flow)}`,
    `phase: ${command.phase}`,
    `objective: ${command.objective}`,
    `known: ${formatPlannerFacts(command.knownFacts)}`,
    `missing: ${formatPlannerMissingFacts(command.missingFacts)}`,
    `nextSafeAction: ${nextSafeAction}`,
    `nextAction: ${command.tool ?? command.nextAction}`,
    `allowedTools: ${formatList(command.allowedTools)}`,
    `blockedActions: ${formatPlannerBlockedActions(command.blockedActions)}`,
    "</turn_state>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function formatPlannerFacts(facts: WorkflowCommand["knownFacts"]): string {
  if (facts.length === 0) return "none";
  return facts.map((fact) => `${fact.key}=${fact.value}`).join("; ");
}

function formatPlannerMissingFacts(
  missingFacts: WorkflowCommand["missingFacts"],
): string {
  if (missingFacts.length === 0) return "none";
  return missingFacts.map((fact) => fact.key).join(", ");
}

function formatPlannerBlockedActions(
  blockedActions: WorkflowCommand["blockedActions"],
): string {
  if (blockedActions.length === 0) return "none";
  return blockedActions
    .map((blocked) =>
      blocked.until
        ? `${blocked.action} until ${blocked.until}`
        : `${blocked.action}`,
    )
    .join("; ");
}

export function compileContextCapsules(
  flow: CallFlowState,
  directives: FlowContextDirectives = directivesForFlowState(flow),
): string {
  const capsules = [
    `objective: ${shortObjectiveForStep(flow.step, directives)}`,
    `patient: ${formatPatientCapsule(flow)}`,
    stepSpecificCapsule(flow),
    appointmentCapsule(flow),
    schedulingCapsule(flow),
    confirmationCapsule(flow),
  ].filter(Boolean);

  return ["<context_capsules>", ...capsules, "</context_capsules>"].join("\n");
}

function formatPatientStatus(flow: CallFlowState): string {
  if (flow.patientStatus === "matched") return "matched_not_verified";
  if (flow.patientStatus === "candidate") return "candidate_not_verified";
  return flow.patientStatus;
}

function formatSchedulingGoal(flow: CallFlowState): string {
  const goal = flow.schedulingGoal;
  if (!goal) return "none";

  const parts = [
    goal.appointmentAction ?? "schedule",
    goal.status,
    goal.preferredWindow ? `window=${goal.preferredWindow}` : undefined,
    goal.bookingConfirmed ? "bookingConfirmed" : undefined,
    goal.selectedSlotId ? "selectedSlot=known" : undefined,
  ].filter(Boolean);

  return parts.join(" ");
}

function activePatient(flow: CallFlowState) {
  return flow.patients[flow.activePatientRef ?? "caller"];
}

function formatPatientCapsule(flow: CallFlowState): string {
  const patient = activePatient(flow);
  if (!patient) return `${formatPatientStatus(flow)}; no patient facts loaded`;

  const facts = [
    formatPatientStatus(flow),
    patient.firstName?.confirmed ? "firstName=confirmed" : undefined,
    patient.dob?.confirmed
      ? "dob=confirmed"
      : patient.dob
        ? "dob=known"
        : undefined,
    patient.relationshipToCaller && patient.relationshipToCaller !== "unknown"
      ? `relationship=${patient.relationshipToCaller}`
      : undefined,
    patient.appointments.length > 0
      ? `loadedAppointments=${patient.appointments.length}`
      : undefined,
  ].filter(Boolean);

  return facts.join("; ") || formatPatientStatus(flow);
}

function stepSpecificCapsule(flow: CallFlowState): string {
  switch (flow.step) {
    case "understand_intent":
      return "step: listen first; do not use business tools yet.";
    case "triage_visit_type":
      return "step: ask visit reason; classify before insurance or availability.";
    case "check_insurance":
      return `step: check plan with coverageType=${flow.coverageType ?? "unknown"}.`;
    case "route_office":
      return "step: explain routing, get agreement, then route without transfer.";
    case "verify_patient":
      return "step: verify active patient; first-name confirmation can verify a preloaded match.";
    case "collect_registration":
      return "step: collect missing registration fields, confirm key fields, then add_patient.";
    case "collect_visit_reason":
      return "step: collect reason and referring doctor; use none if no referrer.";
    case "get_availability":
      return "step: ask date/window if missing, then search right lane once.";
    case "confirm_booking":
      return "step: offer one best slot; wait for explicit yes before booking.";
    case "book":
      return "step: book confirmed slot; save note only after booking succeeds.";
    case "confirm_cancel":
      return "step: read back exact loaded appointment and get cancel confirmation.";
    case "cancel":
      return "step: cancel only the confirmed loaded appointment.";
    case "handoff":
      return "step: say transfer message, get agreement, wait for playout, transfer once.";
    case "answer":
      return "step: answer from tool results or lookup_knowledge, then pause.";
  }
}

function appointmentCapsule(flow: CallFlowState): string {
  const patient = activePatient(flow);
  if (!patient?.appointments.length) return "";
  if (
    flow.activeFlow !== "appointment_management" &&
    !flow.activeIntent?.startsWith("existing_appointment") &&
    flow.step !== "confirm_cancel" &&
    flow.step !== "cancel"
  ) {
    return "";
  }

  return `appointments: loaded=${patient.appointments.length}; use caller context or tool result for exact ID/date.`;
}

function schedulingCapsule(flow: CallFlowState): string {
  const goal = flow.schedulingGoal;
  const latestSearch = [...flow.availabilitySearches]
    .reverse()
    .find((search) => search.status !== "invalidated");
  const facts = [
    goal?.visitReason ? "reason=known" : undefined,
    goal?.preferredWindow ? "preferredWindow=known" : undefined,
    goal?.noteDraft?.appointmentReason ? "noteReason=known" : undefined,
    goal?.noteDraft?.referringDoctor ? "referrer=known" : undefined,
    latestSearch
      ? `availability=${latestSearch.status}; searches=${latestSearch.exactSearchCount}/${latestSearch.maxSearches}; cachedSlots=${latestSearch.cachedSlots.length}`
      : undefined,
  ].filter(Boolean);

  return facts.length > 0 ? `scheduling_context: ${facts.join("; ")}` : "";
}

function shortObjectiveForStep(
  step: CallFlowState["step"],
  directives: FlowContextDirectives,
): string {
  switch (step) {
    case "triage_visit_type":
      return "classify visit";
    case "check_insurance":
      return "check coverage";
    case "route_office":
      return "route with agreement";
    case "verify_patient":
      return "verify patient";
    case "collect_registration":
      return "collect registration";
    case "collect_visit_reason":
      return "collect scheduling note facts";
    case "get_availability":
      return "search availability";
    case "confirm_booking":
      return "confirm slot";
    case "book":
      return "book confirmed slot";
    case "confirm_cancel":
      return "confirm cancellation";
    case "cancel":
      return "cancel confirmed appointment";
    case "handoff":
      return "transfer safely";
    case "answer":
      return "answer and pause";
    case "understand_intent":
      return "understand intent";
    default:
      return directives.currentObjective;
  }
}

function confirmationCapsule(flow: CallFlowState): string {
  const pending = flow.pendingActions.filter(
    (action) => !action.consumed && !action.invalidated,
  );
  const facts = [
    flow.pendingConfirmation
      ? `pendingConfirmation=${flow.pendingConfirmation.type}`
      : undefined,
    pending.length > 0
      ? `pendingActions=${pending
          .map(
            (action) =>
              `${action.type}:${action.confirmed ? "confirmed" : "needs_confirmation"}`,
          )
          .join(",")}`
      : undefined,
  ].filter(Boolean);

  return facts.length > 0 ? `confirmation_context: ${facts.join("; ")}` : "";
}
