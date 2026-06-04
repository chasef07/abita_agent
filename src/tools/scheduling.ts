import {
  getOfficeConfig,
  SPRING_HILL_OFFICE_PHONE,
} from "../customer/profile.js";
import {
  activeOfficeKey,
  activeRoutingContext,
  clearAvailabilitySelection,
  currentWorkflowVisitType,
  setActiveOfficeKey,
  type CallState,
} from "../state/call-state.js";

export function getAmdOfficeForToolCall(state: CallState): string {
  return (
    state.office.phoneOverrides[activeOfficeKey(state)] ||
    getOfficeConfig(activeOfficeKey(state)).amdOfficePhone
  );
}

export function ensureRoutineVisionOffice(state: CallState): void {
  if (!isRoutineVisionScheduling(state)) return;
  if (
    !getOfficeConfig(activeOfficeKey(state)).features
      .routeRoutineVisionToSpringHill
  ) {
    return;
  }
  clearAvailabilitySelection(state);
  state.office.phoneOverrides = {
    ...state.office.phoneOverrides,
    "spring-hill": SPRING_HILL_OFFICE_PHONE,
  };
  setActiveOfficeKey(state, "spring-hill");
}

export function routingForAvailability(state: CallState): string | null {
  if (isRoutineVisionScheduling(state)) {
    return "optical_only";
  }
  return activeRoutingContext(state).routing;
}

function isRoutineVisionScheduling(state: CallState): boolean {
  return currentWorkflowVisitType(state) === "routine_vision";
}
