import {
  canonicalInsurancePlan,
  matchInsurancePlanForOffice,
  normalizeCoverageType,
  type InsuranceCoverageType,
} from "../insurance-rules.js";
import type { OfficeKey } from "../customer/profile.js";
import type {
  CallFlowState,
  PatientStatus,
  SchedulingRouting,
  ToolOutcome,
  VisitType,
} from "./types.js";
import { nextPatientFlowStep } from "./state.js";

export interface PrepareSchedulingPathInput {
  officeKey: OfficeKey;
  patientStatus: PatientStatus;
  visitReason?: string;
  insurancePlan?: string;
  coverageType?: InsuranceCoverageType;
}

export interface PrepareSchedulingPathFacts {
  visitType: VisitType;
  coverageType: InsuranceCoverageType;
  allowedOffice: OfficeKey;
  routing?: SchedulingRouting;
  canonicalPlan?: string;
  acceptedAtAlternateOffice?: OfficeKey;
}

export type PrepareSchedulingPathOutcome = ToolOutcome & {
  facts?: PrepareSchedulingPathFacts;
};

const ROUTINE_VISION_PATTERNS = [
  /\broutine\b/,
  /\bannual\b/,
  /\beye exam\b/,
  /\bvision check\b/,
  /\bglasses\b/,
  /\bcontacts?\b/,
  /\bglasses prescription\b/,
  /\bcontact lens prescription\b/,
  /\bcontacts prescription\b/,
  /\bexamen de la vista\b/,
  /\bexamen de vision\b/,
  /\blentes\b/,
  /\banteojos\b/,
  /\bgafas\b/,
  /\bcontactos\b/,
];

const OPTICAL_SHOP_PATTERNS = [
  /\bglasses order\b/,
  /\border\b.*\b(glasses|contacts)\b/,
  /\bcontact lens order\b/,
  /\bframe adjustment\b/,
  /\bbroken glasses\b/,
  /\bpick ?up\b.*\b(glasses|contacts)\b/,
  /\bwarranty\b/,
  /\brepair\b.*\b(glasses|frames)\b/,
  /\barreglar\b.*\b(lentes|gafas|anteojos)\b/,
  /\brecoger\b.*\b(lentes|gafas|anteojos|contactos)\b/,
];

const URGENT_PATTERNS = [
  /\bsudden vision loss\b/,
  /\bretinal tear\b/,
  /\bretinal detachment\b/,
  /\bflashes\b/,
  /\bfloaters\b/,
  /\blightning bolts?\b/,
  /\bsevere eye pain\b/,
  /\bER\b/i,
  /\bemergency\b/,
  /\bhospital\b/,
  /\bperdida repentina\b.*\bvision\b/,
  /\bdolor fuerte\b.*\bojo\b/,
  /\bemergencia\b/,
];

const SPRING_HILL_MEDICAL_PATTERNS = [
  /\bcataract\b/,
  /\bpediatric\b/,
  /\bchild\b/,
  /\bkid\b/,
  /\bminor\b/,
  /\bunder 18\b/,
  /\bcatarata\b/,
  /\bnino\b/,
  /\bnina\b/,
  /\bmenor\b/,
];

const MEDICAL_PATTERNS = [
  /\bglaucoma\b/,
  /\bcataract\b/,
  /\bretina\b/,
  /\bpost[ -]?op\b/,
  /\bfollow[ -]?up\b/,
  /\breferral\b/,
  /\bdouble vision\b/,
  /\beyelid\b/,
  /\buveitis\b/,
  /\bsymptoms?\b/,
  /\bmedical\b/,
  /\bcatarata\b/,
  /\bvision borrosa\b/,
  /\bdolor\b.*\bojo\b/,
];

const INSURANCE_ONLY_PATTERNS = [
  /\binsurance\b/,
  /\bcoverage\b/,
  /\bplan\b/,
  /\bdo you take\b/,
  /\baccept\b/,
  /\bseguro\b/,
  /\baceptan\b/,
];

export function classifyVisitType(
  visitReason?: string | null,
): VisitType | null {
  const normalized = visitReason?.trim().toLowerCase();
  if (!normalized) return null;

  if (URGENT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "urgent";
  }
  if (OPTICAL_SHOP_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "optical_shop";
  }
  if (ROUTINE_VISION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "routine_vision";
  }
  if (MEDICAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "medical";
  }
  if (INSURANCE_ONLY_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return null;
  }
  return null;
}

function baseStatePatch(
  input: PrepareSchedulingPathInput,
  visitType: VisitType,
  coverageType: InsuranceCoverageType,
  officeKey: OfficeKey,
  routing?: SchedulingRouting,
): Partial<CallFlowState> {
  return {
    activeFlow: "scheduling",
    step: nextPatientFlowStep(input.patientStatus),
    officeKey,
    visitType,
    coverageType,
    routing,
  };
}

export function prepareSchedulingPath(
  input: PrepareSchedulingPathInput,
): PrepareSchedulingPathOutcome {
  const visitType = classifyVisitType(input.visitReason);

  if (!visitType) {
    return {
      outcome: "needs_clarification",
      nextStep: "triage_visit_type",
      statePatch: {
        activeFlow: "intent",
        step: "triage_visit_type",
        officeKey: input.officeKey,
        patientStatus: input.patientStatus,
        requiredSlots: ["visitReason"],
      },
      speak:
        "Ask what the caller needs to be seen for before checking insurance or scheduling.",
      retryable: true,
    };
  }

  const coverageType = normalizeCoverageType(
    input.coverageType ??
      (visitType === "routine_vision" ? "routine_vision" : "medical"),
  );
  const routing: SchedulingRouting | undefined =
    visitType === "routine_vision" ? "optical_only" : undefined;

  if (visitType === "urgent") {
    return {
      outcome: "transfer_required",
      nextStep: "handoff",
      statePatch: {
        activeFlow: "transfer",
        step: "handoff",
        officeKey: input.officeKey,
        visitType,
        coverageType,
      },
      speak:
        "Treat this as urgent. Keep the response short and route to the office for clinical direction.",
      facts: {
        visitType,
        coverageType,
        allowedOffice: input.officeKey,
      },
    };
  }

  if (visitType === "optical_shop") {
    return {
      outcome: "transfer_required",
      nextStep: "handoff",
      statePatch: {
        activeFlow: "transfer",
        step: "handoff",
        officeKey: input.officeKey,
        visitType,
        coverageType,
      },
      speak:
        "This is an optical shop task. Transfer to the office instead of scheduling through the agent.",
      facts: {
        visitType,
        coverageType,
        allowedOffice: input.officeKey,
      },
    };
  }

  const shouldRouteCrystalRiverToSpringHill =
    input.officeKey === "crystal-river" &&
    (visitType === "routine_vision" ||
      SPRING_HILL_MEDICAL_PATTERNS.some((pattern) =>
        pattern.test(input.visitReason?.trim().toLowerCase() ?? ""),
      ));

  if (shouldRouteCrystalRiverToSpringHill) {
    return {
      outcome: "route_required",
      nextStep: "route_office",
      statePatch: {
        activeFlow: "routing",
        step: "route_office",
        officeKey: input.officeKey,
        patientStatus: input.patientStatus,
        visitType,
        coverageType,
        routing,
      },
      speak:
        "Explain that Spring Hill handles this visit type, get the caller's agreement, then route to Spring Hill and continue scheduling.",
      facts: {
        visitType,
        coverageType,
        allowedOffice: "spring-hill",
        routing,
      },
    };
  }

  if (!input.insurancePlan) {
    const patientStep = nextPatientFlowStep(input.patientStatus);
    const nextStep =
      patientStep === "verify_patient"
        ? "verify_patient"
        : coverageType === "routine_vision" || input.patientStatus === "new"
          ? "check_insurance"
          : patientStep;
    const needsClarification = nextStep !== "get_availability";

    return {
      outcome: needsClarification ? "needs_clarification" : "success",
      nextStep,
      statePatch: {
        ...baseStatePatch(
          input,
          visitType,
          coverageType,
          input.officeKey,
          routing,
        ),
        step: nextStep,
        requiredSlots:
          nextStep === "check_insurance"
            ? ["insurancePlan"]
            : nextStep === "verify_patient"
              ? ["patientIdentity"]
              : [],
      },
      speak:
        nextStep === "check_insurance"
          ? "Ask which insurance plan they will be using before scheduling."
          : nextStep === "verify_patient"
            ? "Verify which patient is calling before checking insurance or scheduling."
            : "Proceed to the next scheduling step.",
      retryable: needsClarification,
      facts: {
        visitType,
        coverageType,
        allowedOffice: input.officeKey,
        routing,
      },
    };
  }

  const localResult = matchInsurancePlanForOffice(
    input.officeKey,
    input.insurancePlan,
    coverageType,
  );
  const localPlan = canonicalInsurancePlan(localResult);

  if (localResult.status === "needs_clarification") {
    return {
      outcome: "needs_clarification",
      nextStep: "check_insurance",
      statePatch: {
        activeFlow: "insurance",
        step: "check_insurance",
        officeKey: input.officeKey,
        patientStatus: input.patientStatus,
        visitType,
        coverageType,
        routing,
        requiredSlots: ["insurancePlan"],
      },
      speak: localResult.callerMessage,
      retryable: true,
      facts: {
        visitType,
        coverageType,
        allowedOffice: input.officeKey,
        routing,
      },
    };
  }

  if (localResult.status === "not_accepted") {
    const springHillResult =
      input.officeKey === "crystal-river"
        ? matchInsurancePlanForOffice(
            "spring-hill",
            input.insurancePlan,
            coverageType,
          )
        : null;
    const springHillPlan = springHillResult
      ? canonicalInsurancePlan(springHillResult)
      : null;

    if (springHillResult?.status === "accepted" && springHillPlan) {
      return {
        outcome: "route_required",
        nextStep: "route_office",
        statePatch: {
          activeFlow: "routing",
          step: "route_office",
          officeKey: input.officeKey,
          patientStatus: input.patientStatus,
          visitType,
          coverageType,
          routing,
        },
        speak: `This plan is not accepted at Crystal River, but Spring Hill accepts ${springHillPlan}. Ask if they want to schedule there, then route if they agree.`,
        facts: {
          visitType,
          coverageType,
          allowedOffice: "spring-hill",
          routing,
          canonicalPlan: springHillPlan,
          acceptedAtAlternateOffice: "spring-hill",
        },
      };
    }

    return {
      outcome: "not_allowed",
      nextStep: "answer",
      statePatch: {
        activeFlow: "insurance",
        step: "answer",
        officeKey: input.officeKey,
        patientStatus: input.patientStatus,
        visitType,
        coverageType,
        routing,
      },
      speak: localResult.callerMessage,
      facts: {
        visitType,
        coverageType,
        allowedOffice: input.officeKey,
        routing,
      },
    };
  }

  const nextStep = nextPatientFlowStep(input.patientStatus);

  return {
    outcome: "success",
    nextStep,
    statePatch: {
      ...baseStatePatch(
        input,
        visitType,
        coverageType,
        input.officeKey,
        routing,
      ),
      step: nextStep,
      requiredSlots: [],
      completedSteps: ["triage_visit_type", "check_insurance"],
    },
    speak: "Proceed to the next scheduling step.",
    facts: {
      visitType,
      coverageType,
      allowedOffice: input.officeKey,
      routing,
      ...(localPlan ? { canonicalPlan: localPlan } : {}),
    },
  };
}
