import {
  getOfficeConfig,
  SPRING_HILL_OFFICE_PHONE,
} from "../customer/profile.js";
import {
  activeInsuranceContext,
  activeOfficeKey,
  activeRoutingContext,
  clearAvailabilitySelection,
  type CallState,
} from "../state/call-state.js";

export function getAmdOfficeForToolCall(state: CallState): string {
  return (
    state.runtime.officePhoneOverrides?.[activeOfficeKey(state)] ||
    getOfficeConfig(activeOfficeKey(state)).amdOfficePhone
  );
}

export function ensureRoutineVisionOffice(state: CallState): void {
  if (activeInsuranceContext(state).coverageType !== "routine_vision") return;
  if (
    !getOfficeConfig(activeOfficeKey(state)).features
      .routeRoutineVisionToSpringHill
  ) {
    return;
  }
  clearAvailabilitySelection(state);
  state.runtime.officePhoneOverrides = {
    ...(state.runtime.officePhoneOverrides ?? {}),
    "spring-hill": SPRING_HILL_OFFICE_PHONE,
  };
  state.officeKey = "spring-hill";
}

export function routingForAvailability(state: CallState): string | null {
  if (activeInsuranceContext(state).coverageType === "routine_vision") {
    return "optical_only";
  }
  return activeRoutingContext(state).routing;
}
