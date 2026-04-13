/**
 * Mock tool implementations for testing.
 * Same names, descriptions, and parameter schemas as real tools —
 * only the execute functions are different (return canned responses, no API calls).
 */

import { llm } from "@livekit/agents";
import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { getOfficeConfigByPhone, SPRING_HILL_OFFICE_PHONE } from "../offices.js";

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

function detectFabrication(
  args: Record<string, unknown>,
): string[] {
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
    description: `Verifies a patient's identity.

For MULTIPLE MATCHES (caller context says multiple patients on this number): just pass firstName and phone — the middleware matches by phone + first name. Do NOT ask for last name or DOB upfront.

For all other cases: pass firstName, lastName, and dob (MM/DD/YYYY).

Do NOT call if phone lookup already verified the patient (single match + confirmed first name). Check CALLER CONTEXT first.

Call with what you heard — don't spell back or echo the name before submitting. The API is the source of truth for spelling.

After response:
- If verified: let them know and move on.
- If routingAmbiguous: ask what type of plan (regular, EPO, HMO, Medicare). If HMO, scheduling starts two weeks out due to preauth.
- If routing is "not_accepted": tell them straightforwardly.
- If not found and you only sent firstName + phone: ask for last name and DOB and retry with full details.
- If not found with full details: ask them to spell their name and retry with corrections.
- If still not found after retry: lead into registration — "ok no worries, let me get you set up."`,
    parameters: z.object({
      firstName: z.string().describe("Patient's first name"),
      lastName: z.string().optional().describe("Patient's last name"),
      dob: z.string().optional().describe("Patient's date of birth in MM/DD/YYYY format"),
      usePhone: z.boolean().optional().describe("Set true for multiple-match flow"),
    }),
    execute: async (args) => {
      log.push({ name: "verify_patient", args });
      return config.verifyResult ?? DEFAULT_VERIFY_NOT_FOUND;
    },
  });

  const mock_add_patient = llm.tool({
    description: `Creates a new patient record. Use only when verify_patient returns no match.

NEVER call this tool with fabricated, guessed, or placeholder data. Every single field must come from what the caller explicitly said during the conversation. If you are missing ANY required field (phone, email, address, insurance card info, etc.), you MUST ask the caller for it before calling this tool. Do not invent values to fill required parameters.

Collect in clusters — keep it moving, don't read back individual fields:
1. Insurance — run check_insurance first. Match what the caller says to an exact plan name from the accepted list.
2. Name + DOB — already have from verify attempts. Skip, don't re-ask.
3. Contact — "what's a good cell number?" then "and email?"
4. Address — "street address, city, state, zip?" Then: "apartment or suite?"
5. Sex — "male or female?"
6. Insurance card — "whose name is on the insurance card?" then "and what's the member ID number?"

Member ID is required. Before submitting: read back name, DOB, insurance plan, and member ID.`,
    parameters: z.object({
      firstName: z.string().describe("Patient's first name"),
      lastName: z.string().describe("Patient's last name"),
      dob: z.string().describe("Date of birth in MM/DD/YYYY format"),
      phone: z.string().describe("Cell phone number, 10 digits only"),
      email: z.string().describe("Email address"),
      street: z.string().describe("Street address"),
      aptSuite: z.string().default("").describe("Apartment or suite number"),
      city: z.string().describe("City"),
      state: z.string().describe("State, 2-letter abbreviation"),
      zip: z.string().describe("Zip code"),
      sex: z.enum(["male", "female"]).describe("Patient's sex"),
      insurance: z.string().describe("Insurance carrier name"),
      subscriberName: z.string().describe("Name on the insurance policy"),
      subscriberNum: z.string().describe("Insurance subscriber/member ID number"),
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
    description: `Gets schedule availability. Requires date (YYYY-MM-DD). Routing and preauth auto-applied from session state.

Determine appointment type (you decide, not the caller):
- New 18+ = 1006, new under 18 = 1004
- Existing: default to follow-up (18+ = 1007, under 18 = 1005). Only use post-op (1008) if the caller mentions recent surgery.

Rules: no same-day (earliest = tomorrow). Under 18 = Dr. Bach only.

After response: suggest one best-fit slot. If no slots returned, tell caller and offer nearest available date. Never call this tool for the same date twice.`,
    parameters: z.object({
      date: z.string().describe("Start date to search, formatted YYYY-MM-DD"),
    }),
    execute: async (args) => {
      log.push({ name: "get_availability", args });
      return config.availabilityResult ?? DEFAULT_AVAILABILITY;
    },
  });

  const mock_confirm_appt = llm.tool({
    description: `Retrieves upcoming appointments (next 60 days) for a verified patient. If appointments are already shown in caller context from phone lookup, skip this tool.`,
    parameters: z.object({}),
    execute: async () => {
      log.push({ name: "confirm_appt", args: {} });
      return config.confirmResult ?? DEFAULT_CONFIRM;
    },
  });

  const mock_cancel_appt = llm.tool({
    description: `Cancels an appointment. Requires appointmentId. Confirm with caller before proceeding.`,
    parameters: z.object({
      appointmentId: z.number().describe("Appointment ID"),
    }),
    execute: async (args) => {
      log.push({ name: "cancel_appt", args });
      return { status: "cancelled", message: "Appointment cancelled successfully" };
    },
  });

  const mock_book_appt = llm.tool({
    description: `Books an appointment. Pass columnId, profileId, startDatetime, duration, and appointmentTypeId from get_availability.`,
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
    description: `Looks up whether the office accepts a specific insurance plan. Returns the accepted plans list with carrier-specific notes.`,
    parameters: z.object({
      plan: z.string().describe("The insurance plan name the caller mentioned"),
    }),
    execute: async (args) => {
      log.push({ name: "check_insurance", args });
      try {
        return readFileSync(join(WORKSPACE, office.insuranceFile), "utf-8");
      } catch {
        return "Insurance list unavailable in test environment.";
      }
    },
  });

  const mock_lookup_knowledge = llm.tool({
    description: `Looks up practice info: hours, location, providers, services, what to bring.`,
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
    description: "Updates a verified patient's insurance.",
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
      "Switches AMD tool calls to the Spring Hill office without transferring the caller. Use this when the caller reached Crystal River but the visit must be scheduled through Spring Hill, especially for pediatrics or cataracts.",
    parameters: z.object({}),
    execute: async () => {
      log.push({ name: "route_to_spring_hill", args: {} });
      return `AMD routing switched to Spring Hill (${SPRING_HILL_OFFICE_PHONE}). Continue the call without transferring.`;
    },
  });

  const mock_transfer_call = llm.tool({
    description:
      "Transfers the caller to a human at the office. BEFORE calling this tool, you MUST fully finish telling the caller you're transferring them. Call this tool EXACTLY ONCE. After this tool executes, the SIP session disconnects and the call is over — do NOT generate a second transfer_call, do NOT generate any further tool calls, and do NOT generate any further text. Your turn ends here.",
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
      ...(office.features.routeToSpringHill ? { route_to_spring_hill: mock_route_to_spring_hill } : {}),
      transfer_call: mock_transfer_call,
    },
    callLog: log,
  };
}

export { DEFAULT_VERIFY_FOUND, DEFAULT_VERIFY_NOT_FOUND, DEFAULT_AVAILABILITY, DEFAULT_BOOK, DEFAULT_CONFIRM };
