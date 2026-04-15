/**
 * Mock tool implementations for testing.
 * Same names, descriptions, and parameter schemas as real tools —
 * only the execute functions are different (return canned responses, no API calls).
 */

import { llm } from "@livekit/agents";
import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import {
  getOfficeConfigByPhone,
  SPRING_HILL_OFFICE_PHONE,
} from "../offices.js";
import {
  buildInsuranceToolResponse,
  matchInsurancePlanForOffice,
} from "../insurance-rules.js";

const WORKSPACE = join(import.meta.dirname, "..", "..", "workspace");

// --- Configurable mock responses ---

export interface MockConfig {
  /** verify_patient response. Default: not_found. */
  verifyResult?: Record<string, unknown>;
  /** get_availability response. Default: one slot on April 14. */
  availabilityResult?: Record<string, unknown>;
  /** book_appt response. Default: booked. */
  bookResult?: Record<string, unknown>;
  /** confirm_appt response. Default: one upcoming appointment. */
  confirmResult?: Record<string, unknown>;
  /** Track tool calls for assertions. */
  callLog?: Array<{ name: string; args: Record<string, unknown> }>;
}

const DEFAULT_VERIFY_NOT_FOUND = {
  status: "not_found",
  message: "No patient found matching the provided information",
};

const DEFAULT_VERIFY_FOUND = {
  status: "verified",
  patientId: "12345",
  name: "TEST,PATIENT",
  dob: "01/01/1980",
  insuranceCarrier: "Florida Blue",
  routing: "general",
  allowedProviders: ["Dr. Noel", "Dr. Bach"],
  routingAmbiguous: false,
  preauthRequired: false,
};

const DEFAULT_AVAILABILITY = {
  searchedDate: "2026-04-14",
  date: "Tuesday, April 14, 2026",
  location: "ABITA EYE GROUP SPRING HILL",
  slots: [
    {
      columnId: 101,
      profileId: 201,
      provider: "Dr. Noel",
      startDatetime: "2026-04-14T09:30",
      duration: 30,
      appointmentTypeId: 1007,
    },
  ],
};

const DEFAULT_BOOK = {
  status: "booked",
  appointmentId: 99999,
  message: "Appointment booked successfully",
};

const DEFAULT_CONFIRM = {
  appointments: [
    {
      id: 88888,
      date: "April 14, 2026",
      time: "9:30 AM",
      provider: "Dr. Noel",
      type: "Follow-up",
      facility: "Spring Hill",
      confirmed: true,
    },
  ],
};

// --- Fabrication detection for add_patient ---

const FABRICATION_PATTERNS = [
  /example\.com/i,
  /test\.com/i,
  /placeholder/i,
  /123 main/i,
  /abc123/i,
  /unknown/i,
  /n\/a/i,
  /^none$/i,
  /^tbd$/i,
  /^xxx/i,
  /lorem/i,
  /fake/i,
  /dummy/i,
];

function detectFabrication(args: Record<string, unknown>): string[] {
  const issues: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") continue;
    for (const pattern of FABRICATION_PATTERNS) {
      if (pattern.test(value)) {
        issues.push(`${key}="${value}" matches fabrication pattern ${pattern}`);
      }
    }
  }
  return issues;
}

// --- Mock tool factory ---

export function createMockTools(config: MockConfig = {}, trunkPhone?: string) {
  const log = config.callLog ?? [];
  const office = getOfficeConfigByPhone(trunkPhone ?? SPRING_HILL_OFFICE_PHONE);

  const mock_verify_patient = llm.tool({
    description: `Verify a patient identity.

Use when you need a patient record for scheduling or appointment actions.
For multiple-match phone flow, pass firstName and usePhone=true.
Otherwise pass firstName, lastName, and dob (MM/DD/YYYY).
Returns verification status, patient identity, and routing data.`,
    parameters: z.object({
      firstName: z.string().describe("Patient's first name"),
      lastName: z.string().optional().describe("Patient's last name"),
      dob: z
        .string()
        .optional()
        .describe("Patient's date of birth in MM/DD/YYYY format"),
      usePhone: z
        .boolean()
        .optional()
        .describe("Set true for multiple-match flow"),
    }),
    execute: async (args) => {
      log.push({ name: "verify_patient", args });
      if (config.verifyResult) return config.verifyResult;
      // Multi-match phone narrow with usePhone=true → simulate successful match
      if (args.usePhone === true && !args.lastName && !args.dob) {
        return DEFAULT_VERIFY_FOUND;
      }
      return DEFAULT_VERIFY_NOT_FOUND;
    },
  });

  const mock_add_patient = llm.tool({
    description: `Create a new patient record.

Use only after verify_patient returns no match.
All fields must come from the caller; do not guess or fabricate values.
If the caller confirms the number they're calling from is correct, phone may be omitted and the session can supply it.
Returns the created patient record and routing data.`,
    parameters: z.object({
      firstName: z.string().describe("Patient's first name"),
      lastName: z.string().describe("Patient's last name"),
      dob: z.string().describe("Date of birth in MM/DD/YYYY format"),
      phone: z
        .string()
        .optional()
        .describe("Cell phone number, 10 digits only"),
      email: z.string().describe("Email address"),
      street: z.string().describe("Street address"),
      aptSuite: z.string().default("").describe("Apartment or suite number"),
      city: z.string().describe("City"),
      state: z.string().describe("State, 2-letter abbreviation"),
      zip: z.string().describe("Zip code"),
      sex: z.enum(["male", "female"]).describe("Patient's sex"),
      insurance: z.string().describe("Insurance carrier name"),
      subscriberName: z.string().describe("Name on the insurance policy"),
      subscriberNum: z
        .string()
        .describe("Insurance subscriber/member ID number"),
    }),
    execute: async (args) => {
      log.push({ name: "add_patient", args });
      // Check for fabricated data
      const fabrications = detectFabrication(args);
      if (fabrications.length > 0) {
        return {
          status: "error",
          message: `FABRICATION DETECTED: ${fabrications.join("; ")}`,
          _testMeta: { fabrications },
        };
      }
      return {
        status: "created",
        patientId: "MOCK-001",
        name: `${args.lastName?.toUpperCase()},${args.firstName?.toUpperCase()}`,
        dob: args.dob,
        routing: "general",
        allowedProviders: ["Dr. Noel"],
        routingAmbiguous: false,
        preauthRequired: false,
      };
    },
  });

  const mock_get_availability = llm.tool({
    description: `Get appointment availability starting from a date (YYYY-MM-DD).

Uses routing and preauth state from session state automatically.
Use after you know the visit reason and appointment type.
Returns available appointment slots.`,
    parameters: z.object({
      date: z.string().describe("Start date to search, formatted YYYY-MM-DD"),
    }),
    execute: async (args) => {
      log.push({ name: "get_availability", args });
      return config.availabilityResult ?? DEFAULT_AVAILABILITY;
    },
  });

  const mock_confirm_appt = llm.tool({
    description: `Get upcoming appointments for the verified patient.

Requires a verified patient in session state.
Use when you need fresh appointment data or it is not already available in caller context.
Returns upcoming appointments.`,
    parameters: z.object({}),
    execute: async () => {
      log.push({ name: "confirm_appt", args: {} });
      return config.confirmResult ?? DEFAULT_CONFIRM;
    },
  });

  const mock_cancel_appt = llm.tool({
    description: `Cancel an appointment by appointmentId.

Use only after the caller confirms they want that appointment cancelled.
The appointment is not cancelled until this tool succeeds.`,
    parameters: z.object({
      appointmentId: z.number().describe("Appointment ID"),
    }),
    execute: async (args) => {
      log.push({ name: "cancel_appt", args });
      return {
        status: "cancelled",
        message: "Appointment cancelled successfully",
      };
    },
  });

  const mock_book_appt = llm.tool({
    description: `Book an appointment slot for the verified patient.

Pass columnId, profileId, startDatetime, duration, and appointmentTypeId from get_availability.
Patient ID is read from session state automatically.
Returns booking status and appointment details.`,
    parameters: z.object({
      columnId: z.number().describe("columnId from get_availability"),
      profileId: z.number().describe("profileId from get_availability"),
      startDatetime: z.string().describe("Slot datetime from get_availability"),
      duration: z.number().describe("Slot duration in minutes"),
      appointmentTypeId: z.number().describe("Appointment type ID"),
    }),
    execute: async (args) => {
      log.push({ name: "book_appt", args });
      return config.bookResult ?? DEFAULT_BOOK;
    },
  });

  const mock_check_insurance = llm.tool({
    description: `Look up whether the office accepts a specific insurance plan or family alias.

Use when a caller asks if a plan is accepted or during new-patient registration.
Do NOT force HMO, PPO, or Medicare as a default follow-up. Only ask for that kind of clarification if this tool returns clarificationNeeded.

The tool returns:
- status
- canProceed
- canonicalPlan
- clarificationNeeded
- callerMessage`,
    parameters: z.object({
      plan: z.string().describe("The insurance plan name the caller mentioned"),
    }),
    execute: async (args) => {
      log.push({ name: "check_insurance", args });
      const result = matchInsurancePlanForOffice(office.key, args.plan);
      return buildInsuranceToolResponse(result);
    },
  });

  const mock_lookup_knowledge = llm.tool({
    description: `Look up office information for the current office.

Use for questions about hours, location, providers, services, what to bring, and related practice facts.
Returns the office knowledge reference.`,
    parameters: z.object({
      question: z.string().describe("What the caller is asking about"),
    }),
    execute: async (args) => {
      log.push({ name: "lookup_knowledge", args });
      try {
        return readFileSync(join(WORKSPACE, office.knowledgeFile), "utf-8");
      } catch {
        return "Knowledge base unavailable in test environment.";
      }
    },
  });

  const mock_update_insurance = llm.tool({
    description: `Update insurance for a verified patient.

Requires a verified patient in session state.
Run check_insurance first and use the canonicalPlan from the latest result when it is available.
Updates session routing and insurance state from the result.`,
    parameters: z.object({
      insurance: z.string(),
      subscriberName: z.string(),
      subscriberNum: z.string(),
    }),
    execute: async (args) => {
      log.push({ name: "update_insurance", args });
      return {
        status: "updated",
        patientId: "12345",
        oldInsurance: "Florida Blue",
        newInsurance: args.insurance,
        routing: "all_three",
        allowedProviders: ["Dr. Bach", "Dr. Noel", "Dr. Licht"],
        routingAmbiguous: false,
        preauthRequired: false,
        message: "Insurance updated successfully",
      };
    },
  });

  const mock_route_to_spring_hill = llm.tool({
    description:
      "Route AMD tool calls to the Spring Hill office without transferring the caller. Use on Crystal River calls when the visit must be scheduled through Spring Hill. Updates AMD office routing for the rest of the call.",
    parameters: z.object({}),
    execute: async () => {
      log.push({ name: "route_to_spring_hill", args: {} });
      return `AMD routing switched to Spring Hill (${SPRING_HILL_OFFICE_PHONE}). Continue the call without transferring.`;
    },
  });

  const mock_transfer_call = llm.tool({
    description:
      "Transfer the caller to the office. Use when the call must be handed to a human. Say the transfer message before calling this tool. After this tool succeeds, the call is effectively over.",
    parameters: z.object({}),
    execute: async () => {
      log.push({ name: "transfer_call", args: {} });
      return "Transfer initiated successfully.";
    },
  });

  return {
    tools: {
      verify_patient: mock_verify_patient,
      add_patient: mock_add_patient,
      update_insurance: mock_update_insurance,
      get_availability: mock_get_availability,
      confirm_appt: mock_confirm_appt,
      cancel_appt: mock_cancel_appt,
      book_appt: mock_book_appt,
      check_insurance: mock_check_insurance,
      lookup_knowledge: mock_lookup_knowledge,
      ...(office.features.routeToSpringHill
        ? { route_to_spring_hill: mock_route_to_spring_hill }
        : {}),
      transfer_call: mock_transfer_call,
    },
    callLog: log,
  };
}

export {
  DEFAULT_VERIFY_FOUND,
  DEFAULT_VERIFY_NOT_FOUND,
  DEFAULT_AVAILABILITY,
  DEFAULT_BOOK,
  DEFAULT_CONFIRM,
};
