import type { InsuranceDecision } from "../clients/insurance-decision.js";
import {
  decisionMatches,
  schedulingBlockedAnswer,
} from "../clients/insurance-decision.js";
import { activeOfficeKey } from "../state/call-lifecycle.js";
import type { InsuranceCoverageType } from "../insurance-rules.js";
import type {
  CallState,
  InsuranceEligibilityCheck,
  InsuranceSnapshot,
  VisitType,
} from "../state/call-state.js";
import { clearAvailabilitySelection } from "./availability.js";

type SchedulingRouting =
  "bach_only" | "bach_licht" | "all_three" | "optical_only";

export function createSchedulingState(input: {
  insuranceCarrier: string | null;
  checkedInsurancePlan: string | null;
  checkedInsuranceCoverageType: InsuranceCoverageType | null;
  routing: string | null;
  preauthRequired: boolean;
}): Pick<CallState, "insurance" | "workflow" | "availability"> {
  const routing = normalizeSchedulingRouting(input.routing);
  const coverageType =
    input.checkedInsuranceCoverageType ??
    (routing === "optical_only" ? "routine_vision" : null);
  const checkedPlan = input.checkedInsurancePlan ?? input.insuranceCarrier;
  const onFile = checkedPlan
    ? insuranceSnapshot({
        plan: checkedPlan,
        canonicalPlan: checkedPlan,
        coverageType,
        currentCarrier: input.insuranceCarrier ?? checkedPlan,
      })
    : null;
  return {
    insurance: {
      onFile,
      lastEligibilityCheck: null,
    },
    workflow: {
      visitType: null,
      routing: {
        routing,
        preauthRequired: input.preauthRequired,
      },
    },
    availability: {
      slots: [],
      requestedStartDate: undefined,
      latestRouting: null,
      bookingTokensBySlotId: {},
      nextSlotIndex: 0,
    },
  };
}

export function insuranceOnFile(state: CallState): InsuranceSnapshot | null {
  return state.insurance.onFile;
}

export function lastInsuranceEligibilityCheck(
  state: CallState,
): InsuranceEligibilityCheck | null {
  return state.insurance.lastEligibilityCheck;
}

export function setInsuranceOnFile(
  state: CallState,
  insurance: InsuranceSnapshot | null,
): void {
  state.insurance.onFile = insurance;
}

export function setLastInsuranceEligibilityCheck(
  state: CallState,
  check: InsuranceEligibilityCheck | null,
): void {
  state.insurance.lastEligibilityCheck = check;
}

export function setWorkflowVisitType(
  state: CallState,
  visitType: VisitType,
): void {
  if (state.workflow.visitType === visitType) return;
  state.workflow.visitType = visitType;
  clearAvailabilitySelection(state, { invalidateReads: true });
}

export function activeRoutingContext(state: CallState): {
  routing: SchedulingRouting | null;
  preauthRequired: boolean;
} {
  return {
    routing: state.workflow.routing.routing ?? null,
    preauthRequired: state.workflow.routing.preauthRequired,
  };
}

export function resetPatientSchedulingState(
  state: CallState,
  options: { preserveEligibilityCheck?: boolean } = {},
): void {
  const eligibilityCheck = options.preserveEligibilityCheck
    ? state.insurance.lastEligibilityCheck
    : null;
  clearAvailabilitySelection(state, {
    invalidateReads: true,
  });
  state.workflow.visitType = null;
  setLastInsuranceEligibilityCheck(state, eligibilityCheck);
  setRoutingContext(state, {});
}

function normalizeSchedulingRouting(
  value: string | null | undefined,
): SchedulingRouting | null {
  return value === "bach_only" ||
    value === "bach_licht" ||
    value === "all_three" ||
    value === "optical_only"
    ? value
    : null;
}

export function setRoutingContext(
  state: CallState,
  routing: {
    routing?: string | null;
    preauthRequired?: boolean;
  },
): void {
  const nextRouting = {
    routing: normalizeSchedulingRouting(routing.routing),
    preauthRequired: routing.preauthRequired ?? false,
  };
  const currentRouting = state.workflow.routing;
  if (
    currentRouting.routing !== nextRouting.routing ||
    currentRouting.preauthRequired !== nextRouting.preauthRequired
  ) {
    clearAvailabilitySelection(state, {
      invalidateReads: true,
    });
  }
  state.workflow.routing = nextRouting;
}

export function insuranceSnapshot(input: {
  plan?: string | null;
  canonicalPlan?: string | null;
  decision?: InsuranceDecision;
  coverageType?: InsuranceCoverageType | null;
  currentCarrier?: string | null;
}): InsuranceSnapshot {
  const plan = input.plan?.trim() || input.canonicalPlan?.trim() || null;
  const canonicalPlan = input.canonicalPlan?.trim() || plan;
  return {
    plan,
    canonicalPlan,
    ...(input.decision ? { decision: input.decision } : {}),
    coverageType: input.coverageType ?? null,
    currentCarrier: input.currentCarrier?.trim() || plan,
  };
}

// Both consumers use the current patient-owned check; an unsuccessful recheck
// must never revive the older on-file decision.
export function insuranceForScheduling(
  state: CallState,
): InsuranceSnapshot | null {
  return state.insurance.lastEligibilityCheck ?? state.insurance.onFile;
}
export function medicalInsuranceSchedulingBlock(
  state: CallState,
): string | null {
  if (
    state.workflow.visitType !== "medical" ||
    activeOfficeKey(state).endsWith("-demo")
  )
    return null;
  const current = insuranceForScheduling(state);
  if (
    state.insurance.lastEligibilityCheck &&
    !state.insurance.lastEligibilityCheck.accepted
  )
    return (
      (current?.decision && !current.decision.canRegister
        ? current.decision.answer
        : null) ?? "Check the exact medical insurance plan before scheduling."
    );
  const decision = current?.decision;
  if (decision && !decisionMatches(decision, activeOfficeKey(state), "medical"))
    return "Check medical insurance for the selected office before scheduling.";
  if (decision && !decision.canSchedule)
    return schedulingBlockedAnswer(decision);
  return null; // Existing chart insurance is checked by patient-scoped middleware.
}

export function blockPatientWrites(
  state: CallState,
  patientId: string,
  message: string,
): void {
  (state.identity.schedulingWriteBlocks ??= {})[patientId] = message;
}
