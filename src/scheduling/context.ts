import { type CallState } from "../state/call-state.js";
import { currentWorkflowVisitType } from "./state.js";
import { SchedulingInputRequired } from "./input-required.js";

export function ensureAvailabilityContext(
  state: CallState,
  action: string,
): void {
  if (currentWorkflowVisitType(state)) return;
  throw new SchedulingInputRequired(
    `I need to know whether this is medical or routine vision before ${action}.`,
  );
}

export function availabilityContextRecovery(state: CallState): string | null {
  return currentWorkflowVisitType(state)
    ? null
    : "Is this visit for medical care or routine vision?";
}
