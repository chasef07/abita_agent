import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryOwnedMiddleware,
  setOwnedMiddleware,
  type PatientResolveResult,
} from "../clients/owned-middleware.js";
import { SPRING_HILL_OFFICE_PHONE } from "../customers/abita/profile.js";
import {
  buildPreCallContextState,
  loadPreCallBootstrap,
  lookupByPhone,
} from "../runtime/precall-bootstrap.js";

function usePatientResult(result: PatientResolveResult) {
  const middleware = new InMemoryOwnedMiddleware({
    resolvePatient: [result],
  });
  setOwnedMiddleware(middleware);
  return middleware;
}

function verifiedPatient(
  overrides: Partial<
    Extract<PatientResolveResult, { status: "verified" }>
  > = {},
): Extract<PatientResolveResult, { status: "verified" }> {
  return {
    status: "verified",
    patientId: "patient-1",
    name: "Doe, Jane",
    dob: "01/01/1980",
    phone: "+17275551212",
    insuranceCarrier: "Aetna",
    insPlanId: "plan-1",
    respPartyId: "resp-1",
    routing: "all_three",
    allowedProviders: [],
    routingAmbiguous: false,
    preauthRequired: false,
    appointmentsStatus: "none",
    appointmentsMessage: null,
    appointments: [],
    message: null,
    ...overrides,
  };
}

describe("pre-call bootstrap", () => {
  afterEach(() => {
    setOwnedMiddleware(undefined);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns an explicit no_match outcome instead of null", async () => {
    usePatientResult({ status: "not_found" });

    const result = await lookupByPhone(
      "+17275551212",
      SPRING_HILL_OFFICE_PHONE,
    );

    expect(result).toMatchObject({
      status: "no_match",
      phone: "+17275551212",
      message: "No patient match found.",
    });
  });

  it("keeps middleware failures separate from no-match callers", async () => {
    usePatientResult({
      status: "error",
      reason: "middleware_error",
    });

    const result = await lookupByPhone(
      "+17275551212",
      SPRING_HILL_OFFICE_PHONE,
    );

    expect(result).toMatchObject({
      status: "lookup_failed",
      phone: "+17275551212",
      reason: "middleware_error",
      retryable: true,
    });
  });

  it("treats 200 error payloads as lookup failures", async () => {
    usePatientResult({
      status: "error",
      reason: "middleware_error",
    });

    const result = await lookupByPhone(
      "+17275551212",
      SPRING_HILL_OFFICE_PHONE,
    );

    expect(result).toMatchObject({
      status: "lookup_failed",
      phone: "+17275551212",
      reason: "middleware_error",
      retryable: true,
    });
  });

  it("builds bootstrap state with lookup telemetry", async () => {
    const middleware = usePatientResult(verifiedPatient());

    const bootstrap = await loadPreCallBootstrap({
      callerPhone: "+17275551212",
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
    });

    expect(bootstrap).toMatchObject({
      verified: {
        patientId: "patient-1",
        name: "Doe, Jane",
        appointmentsStatus: "none",
      },
      telemetry: {
        status: "verified",
      },
    });
    expect(middleware.requests.resolvePatient[0]).toMatchObject({
      identity: { phone: "+17275551212" },
    });
    expect(bootstrap.telemetry.durationMs).toEqual(expect.any(Number));
  });

  it("accepts verified phone lookups when middleware omits echoed phone", async () => {
    usePatientResult(
      verifiedPatient({
        phone: null,
        appointmentsStatus: "found",
        appointments: [
          {
            id: 12345,
            date: "2026-06-01",
            time: "9:00 AM",
            provider: "Dr. Bach",
            type: "Follow-up",
            facility: "Spring Hill",
            confirmed: true,
          },
        ],
      }),
    );

    const result = await lookupByPhone(
      "+17275551212",
      SPRING_HILL_OFFICE_PHONE,
    );

    expect(result).toMatchObject({
      status: "verified",
      phone: "+17275551212",
      appointmentsStatus: "found",
      appointments: [expect.objectContaining({ id: 12345 })],
    });
  });

  it("maps lookup outcomes into session pre-call state", () => {
    const single = buildPreCallContextState(
      {
        status: "verified",
        patientId: "patient-1",
        name: "Doe, Jane",
        dob: "01/01/1980",
        phone: "+17275551212",
        insuranceCarrier: "Aetna",
        insPlanId: "plan-1",
        respPartyId: "resp-1",
        routing: "all_three",
        allowedProviders: ["Dr. Bach"],
        routingAmbiguous: false,
        appointmentsStatus: "found",
        appointmentsMessage: null,
        appointments: [
          {
            id: 12345,
            date: "2026-06-01",
            time: "9:00 AM",
            provider: "Dr. Bach",
            type: "Follow-up",
            facility: "Spring Hill",
            confirmed: true,
          },
        ],
      },
      "+17275551212",
    );

    expect(single).toMatchObject({
      status: "single_match_pending_confirmation",
      selectedCandidateRef: "caller",
      appointmentLoadStatus: "found",
      candidates: [
        {
          ref: "caller",
          firstName: "Jane",
          lastName: "Doe",
          patientId: "patient-1",
          relationshipToCaller: "self",
          insuranceCarrier: "Aetna",
          insPlanId: "plan-1",
          respPartyId: "resp-1",
          routing: "all_three",
          allowedProviders: ["Dr. Bach"],
        },
      ],
    });

    const multiple = buildPreCallContextState(
      {
        status: "multiple_matches",
        message: "multiple",
        matches: [{ firstName: "Jane" }, { firstName: "Maria" }],
      },
      "+17275551212",
    );

    expect(multiple).toMatchObject({
      status: "multiple_matches_pending_selection",
      candidates: [
        { ref: "precall:1", firstName: "Jane" },
        { ref: "precall:2", firstName: "Maria" },
      ],
    });

    expect(
      buildPreCallContextState(
        {
          status: "lookup_failed",
          phone: "+17275551212",
          reason: "network_error",
          retryable: true,
        },
        "+17275551212",
      ),
    ).toMatchObject({
      status: "lookup_failed",
      failureReason: "network_error",
      retryable: true,
    });
  });

  it("stores full multiple-match patient details in pre-call candidates", async () => {
    usePatientResult({
      status: "multiple_matches",
      message: "Found 2 patients for this phone number.",
      matches: [
        verifiedPatient({
          allowedProviders: ["Dr. Bach"],
          appointmentsStatus: "found",
          appointments: [
            {
              id: 12345,
              date: "2026-06-01",
              time: "9:00 AM",
              provider: "Dr. Bach",
              type: "Follow-up",
              facility: "Spring Hill",
              confirmed: true,
            },
          ],
        }),
        verifiedPatient({
          patientId: "patient-2",
          name: "Doe, Maria",
          dob: "02/02/1985",
          insuranceCarrier: "Humana",
          routing: "bach_only",
          allowedProviders: ["Dr. Bach"],
          preauthRequired: true,
        }),
      ],
    });

    const result = await lookupByPhone(
      "+17275551212",
      SPRING_HILL_OFFICE_PHONE,
    );
    const preCall = buildPreCallContextState(result, "+17275551212");

    expect(result).toMatchObject({
      status: "multiple_matches",
      matches: [
        {
          status: "verified",
          patientId: "patient-1",
          appointments: [expect.objectContaining({ id: 12345 })],
        },
        {
          status: "verified",
          patientId: "patient-2",
          appointmentsStatus: "none",
        },
      ],
    });
    expect(preCall).toMatchObject({
      status: "multiple_matches_pending_selection",
      candidates: [
        {
          ref: "precall:1",
          firstName: "Jane",
          lastName: "Doe",
          patientId: "patient-1",
          appointmentsStatus: "found",
          insuranceCarrier: "Aetna",
          routing: "all_three",
          allowedProviders: ["Dr. Bach"],
          preauthRequired: false,
        },
        {
          ref: "precall:2",
          firstName: "Maria",
          lastName: "Doe",
          patientId: "patient-2",
          appointmentsStatus: "none",
          insuranceCarrier: "Humana",
          routing: "bach_only",
          preauthRequired: true,
        },
      ],
    });
  });

  it("keeps verified caller context when insurance is missing", async () => {
    usePatientResult(
      verifiedPatient({
        insuranceCarrier: null,
        insPlanId: null,
        respPartyId: null,
        routing: null,
        appointmentsStatus: "found",
        appointments: [
          {
            id: 12345,
            date: "2026-06-01",
            time: "9:00 AM",
            provider: "Dr. Bach",
            type: "Follow-up",
            facility: "Spring Hill",
            confirmed: true,
          },
        ],
      }),
    );

    const result = await lookupByPhone(
      "+17275551212",
      SPRING_HILL_OFFICE_PHONE,
    );

    expect(result).toMatchObject({
      status: "verified",
      insuranceCarrier: null,
      routing: null,
      appointments: [expect.objectContaining({ id: 12345 })],
    });
  });
});
