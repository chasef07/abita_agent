import type {
  BlockedAction,
  CallFlowState,
  ConfirmationType,
  FlowDecision,
  FlowStep,
  GenericTaskPlan,
  MissingFact,
  ParentTaskPlan,
  PatientContext,
  PlannerFact,
  PlannerStatePatch,
  WorkflowCommand,
  WorkflowToolName,
} from "../types.js";

export function applyPlannerPatch(
  flow: CallFlowState,
  command: WorkflowCommand,
): void {
  const patch = command.statePatch;
  if (patch?.taskPlans) flow.taskPlans = patch.taskPlans;
  if (patch?.activeTaskPlanId) flow.activeTaskPlanId = patch.activeTaskPlanId;
  if (patch && "activeIntent" in patch) {
    flow.activeIntent = patch.activeIntent ?? null;
  }
  if (patch?.activeFlow) flow.activeFlow = patch.activeFlow;
  if (patch?.step) {
    flow.step = patch.step;
    if (flow.currentTask) flow.currentTask.step = patch.step;
  }
  if (patch?.patientStatus) flow.patientStatus = patch.patientStatus;
  if (patch?.visitType) flow.visitType = patch.visitType;
  if (patch?.officeKey) flow.officeKey = patch.officeKey;
  if (patch?.coverageType) flow.coverageType = patch.coverageType;
  if (patch?.routing) flow.routing = patch.routing;
  if (patch?.requiredSlots) flow.requiredSlots = patch.requiredSlots;
  if (patch?.completedSteps) {
    flow.completedSteps = mergeCompletedSteps(
      flow.completedSteps,
      patch.completedSteps,
    );
  }
  if (patch && "pendingConfirmation" in patch) {
    flow.pendingConfirmation = patch.pendingConfirmation;
  }
  if (patch?.currentTask) flow.currentTask = patch.currentTask;
  if (patch?.taskStack) flow.taskStack = patch.taskStack;
  if (patch?.schedulingGoal) flow.schedulingGoal = patch.schedulingGoal;
  flow.lastWorkflowCommand = {
    ...command,
    statePatch: undefined,
  };
}

export function flowDecisionForWorkflowCommand(
  command: WorkflowCommand,
): FlowDecision {
  switch (command.nextAction) {
    case "ask":
      return {
        type: "ask",
        slot: command.slot ?? command.missingFacts[0]?.key ?? "clarification",
        promptHint: command.instruction,
      };
    case "call_tool":
      return {
        type: "call_tool",
        tool: command.tool ?? "lookup_knowledge",
        args: command.args ?? {},
      };
    case "confirm":
      return {
        type: "confirm",
        confirmation: {
          type: command.confirmationType ?? "reschedule",
          payload: {
            taskId: command.taskId,
            patientRef: command.patientRef,
          },
        },
      };
    case "complete":
      return {
        type: "say",
        instruction: command.instruction,
      };
    case "respond":
      return {
        type: "say",
        instruction: command.instruction,
      };
  }
}

export function compactWorkflowCommand(command: WorkflowCommand) {
  const blockedSideEffects = sideEffectBlockedActions(command.blockedActions);
  return {
    task: command.taskKind,
    taskId: command.taskId,
    phase: command.phase,
    missingFacts: command.missingFacts.map((fact) => fact.key),
    nextAction: command.tool ?? command.nextAction,
    action: command.nextAction,
    ...(command.suggestedTool ? { suggestedTool: command.suggestedTool } : {}),
    ...(command.tool ? { tool: command.tool } : {}),
    ...(command.args ? { args: command.args } : {}),
    blockedSideEffects: blockedSideEffects.map((blocked) => blocked.action),
    instruction: command.instruction,
  };
}

export function command(
  flow: CallFlowState,
  plan: ParentTaskPlan,
  input: {
    phase: string;
    knownFacts: PlannerFact[];
    missingFacts: MissingFact[];
    nextAction: WorkflowCommand["nextAction"];
    slot?: string;
    tool?: WorkflowToolName;
    args?: unknown;
    allowedTools: WorkflowToolName[];
    blockedActions: BlockedAction[];
    confirmationType?: ConfirmationType;
    instruction: string;
    step?: FlowStep;
    visitType?: CallFlowState["visitType"];
    coverageType?: CallFlowState["coverageType"];
    pendingConfirmation?: CallFlowState["pendingConfirmation"];
    schedulingGoalStatus?: NonNullable<
      CallFlowState["schedulingGoal"]
    >["status"];
    statePatch?: PlannerStatePatch;
    resolvedMetaDecision?: WorkflowCommand["resolvedMetaDecision"];
  },
): WorkflowCommand {
  const nextPlans = {
    ...(flow.taskPlans ?? {}),
    [plan.id]: plan,
  };
  const schedulingGoal =
    input.schedulingGoalStatus && flow.schedulingGoal
      ? {
          ...flow.schedulingGoal,
          status: input.schedulingGoalStatus,
          updatedAt: Date.now(),
        }
      : undefined;
  const statePatch: PlannerStatePatch = {
    ...(input.statePatch ?? {}),
    taskPlans: nextPlans,
    activeTaskPlanId: plan.id,
    step: input.step ?? input.statePatch?.step,
    visitType: input.visitType ?? input.statePatch?.visitType,
    coverageType: input.coverageType ?? input.statePatch?.coverageType,
    pendingConfirmation:
      input.pendingConfirmation ?? input.statePatch?.pendingConfirmation,
  };
  if (schedulingGoal) {
    statePatch.schedulingGoal = schedulingGoal;
  } else if (input.statePatch?.schedulingGoal) {
    statePatch.schedulingGoal = input.statePatch.schedulingGoal;
  }
  return {
    taskId: plan.id,
    taskKind: plan.kind,
    patientRef: plan.patientRef,
    phase: input.phase,
    objective: plan.objective,
    knownFacts: input.knownFacts,
    missingFacts: input.missingFacts,
    nextAction: input.nextAction,
    slot: input.slot,
    tool: input.tool,
    args: input.args,
    suggestedTool: input.tool ?? input.allowedTools[0],
    allowedTools: input.allowedTools,
    blockedActions: input.blockedActions,
    confirmationType: input.confirmationType,
    instruction: input.instruction,
    commandSource: "task_plan",
    resolvedMetaDecision: input.resolvedMetaDecision,
    statePatch,
  };
}

function sideEffectBlockedActions(blockedActions: BlockedAction[]) {
  return blockedActions.filter((blocked) => isSideEffectAction(blocked.action));
}

function isSideEffectAction(action: string): boolean {
  return (
    action === "book_appt" ||
    action === "cancel_appt" ||
    action === "add_patient" ||
    action === "update_insurance" ||
    action === "transfer_call" ||
    action === "route_to_spring_hill" ||
    action === "add_patient_note"
  );
}

export function taskPlanId(
  flow: CallFlowState,
  kind: ParentTaskPlan["kind"],
): string {
  if (
    flow.activeTaskPlanId &&
    flow.taskPlans?.[flow.activeTaskPlanId]?.kind === kind
  ) {
    return flow.activeTaskPlanId;
  }
  if (flow.currentTask?.kind === "appointment_management") {
    return flow.currentTask.id;
  }
  const patientRef = flow.activePatientRef ?? "caller";
  return `task_${kind}_${patientRef}`;
}

export function genericPlan(
  flow: CallFlowState,
  kind: GenericTaskPlan["kind"],
  objective: string,
  phase: string,
): GenericTaskPlan {
  const id = taskPlanId(flow, kind);
  const existingPlan = existingPlanOfKind<GenericTaskPlan>(flow, id, kind);
  return {
    id,
    kind,
    taskFrameId: flow.currentTask?.id,
    patientRef: flow.activePatientRef,
    phase,
    objective,
    createdAt: existingPlan?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
}

export function existingPlanCreatedAt(flow: CallFlowState, id: string): number {
  return flow.taskPlans?.[id]?.createdAt ?? Date.now();
}

export function existingPlanOfKind<T extends ParentTaskPlan>(
  flow: CallFlowState,
  id: string,
  kind: T["kind"],
): T | undefined {
  const plan = flow.taskPlans?.[id];
  return plan?.kind === kind ? (plan as T) : undefined;
}

export function mergeCompletedSteps(
  existing: string[],
  next: string[],
): string[] {
  const merged = [...existing];
  for (const step of next) {
    if (!merged.includes(step)) merged.push(step);
  }
  return merged;
}

export function isVerified(
  patient: PatientContext | undefined,
  flow: CallFlowState,
): boolean {
  return (
    flow.patientStatus === "verified" ||
    flow.patientStatus === "created" ||
    patient?.status === "verified" ||
    patient?.status === "created"
  );
}

export function knownPatientFacts(
  patient: PatientContext | undefined,
  flow: CallFlowState,
): PlannerFact[] {
  return [
    {
      key: "patient",
      value: `${flow.activePatientRef ?? "caller"} ${flow.patientStatus}`,
    },
    patient?.patientId
      ? {
          key: "verifiedPatient",
          value: "patient ID is stored internally",
        }
      : undefined,
  ].filter(isPlannerFact);
}

export function isPlannerFact(
  value: PlannerFact | undefined,
): value is PlannerFact {
  return Boolean(value);
}

export function operationalBlockedActions(reason: string): BlockedAction[] {
  return [
    { action: "add_patient", reason },
    { action: "update_insurance", reason },
    { action: "get_availability", reason },
    { action: "book_appt", reason },
    { action: "cancel_appt", reason },
    { action: "route_to_spring_hill", reason },
    { action: "transfer_call", reason },
  ];
}
