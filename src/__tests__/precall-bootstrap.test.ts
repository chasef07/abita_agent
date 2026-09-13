import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HttpOwnedMiddleware,
  type PatientResolveResult,
} from "../clients/owned-middleware.js";
import { SPRING_HILL_OFFICE_PHONE } from "../customers/abita/profile.js";
import {
  buildPreCallCandidates,
  formatPhoneLookupLogLine,
  lookupByPhone,
} from "../runtime/precall-bootstrap.js";
import { InMemoryOwnedMiddleware } from "./support/owned-middleware.js";

let middleware: InMemoryOwnedMiddleware;

function usePatientResult(result: PatientResolveResult) {
  middleware = new InMemoryOwnedMiddleware({
    resolvePatient: [result],
  });
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns an explicit no_match outcome instead of null", async () => {
    usePatientResult({ status: "not_found" });

    const result = await lookupByPhone(
      middleware,
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
      middleware,
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
      middleware,
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

  it("returns the phone lookup result directly for state initialization", async () => {
    const middleware = usePatientResult(verifiedPatient());

    const lookup = await lookupByPhone(
      middleware,
      "+17275551212",
      SPRING_HILL_OFFICE_PHONE,
    );

    expect(lookup).toMatchObject({
      patientId: "patient-1",
      name: "Doe, Jane",
      appointmentsStatus: "none",
    });
    expect(middleware.requests.resolvePatient[0]).toMatchObject({
      identity: { phone: "+17275551212" },
    });
  });

  it("keeps concurrent call assemblies isolated and forwards cancellation signals", async () => {
    const first = new InMemoryOwnedMiddleware({
      resolvePatient: [verifiedPatient({ patientId: "patient-first" })],
    });
    const second = new InMemoryOwnedMiddleware({
      resolvePatient: [verifiedPatient({ patientId: "patient-second" })],
    });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const [firstLookup, secondLookup] = await Promise.all([
      lookupByPhone(
        first,
        "+17275550001",
        SPRING_HILL_OFFICE_PHONE,
        firstController.signal,
      ),
      lookupByPhone(
        second,
        "+17275550002",
        SPRING_HILL_OFFICE_PHONE,
        secondController.signal,
      ),
    ]);

    expect(firstLookup).toMatchObject({
      status: "verified",
      patientId: "patient-first",
    });
    expect(secondLookup).toMatchObject({
      status: "verified",
      patientId: "patient-second",
    });
    expect(first.requests.resolvePatient).toEqual([
      expect.objectContaining({
        identity: { phone: "+17275550001" },
        signal: firstController.signal,
      }),
    ]);
    expect(second.requests.resolvePatient).toEqual([
      expect.objectContaining({
        identity: { phone: "+17275550002" },
        signal: secondController.signal,
      }),
    ]);
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
            cancellationToken: "private-cancellation-token",
          },
        ],
      }),
    );

    const result = await lookupByPhone(
      middleware,
      "+17275551212",
      SPRING_HILL_OFFICE_PHONE,
    );
    const candidates = buildPreCallCandidates(result);

    expect(result).toMatchObject({
      status: "verified",
      phone: "+17275551212",
      appointmentsStatus: "found",
      appointments: [
        expect.objectContaining({
          id: 12345,
          cancellationToken: "private-cancellation-token",
        }),
      ],
    });
    expect(candidates[0]?.appointments).toEqual([
      expect.objectContaining({
        appointmentRef: expect.stringMatching(/^appointment-[a-z0-9]+$/),
        cancellationToken: "private-cancellation-token",
      }),
    ]);
    expect(formatPhoneLookupLogLine(result)).toBe("[call] Caller match found");
    expect(formatPhoneLookupLogLine(result)).not.toContain(
      "private-cancellation-token",
    );
    expect(formatPhoneLookupLogLine(result)).not.toContain("12345");
  });

  it("preloads middleware appointments without confirmation metadata", async () => {
    const httpMiddleware = new HttpOwnedMiddleware({
      fetch: vi.fn(async () =>
        Response.json({
          status: "verified",
          patientId: "patient-1",
          name: "Doe, Jane",
          dob: "01/01/1980",
          appointmentsStatus: "found",
          appointments: [
            {
              id: 12345,
              date: "Friday, August 1, 2026",
              time: "9:00 AM",
              provider: "Dr. Bach",
            },
          ],
        }),
      ),
      middlewareBaseUrl: "https://middleware.test",
    });

    const result = await lookupByPhone(
      httpMiddleware,
      "+17275551212",
      SPRING_HILL_OFFICE_PHONE,
    );

    expect(result).toMatchObject({
      status: "verified",
      phone: "+17275551212",
      appointmentsStatus: "found",
      appointments: [
        {
          id: 12345,
          provider: "Dr. Bach",
          type: "",
          facility: "",
          confirmed: false,
        },
      ],
    });
  });

  it("maps lookup outcomes into session pre-call state", () => {
    const single = buildPreCallCandidates({
      status: "verified",
      preauthRequired: false,
      patientId: "patient-1",
      name: "Doe, Jane",
      dob: "01/01/1980",
      phone: "+17275551212",
      insuranceCarrier: "Aetna",
      insPlanId: "plan-1",
      respPartyId: "resp-1",
      routing: "all_three",
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
    });

    expect(single).toMatchObject([
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
      },
    ]);

    const multiple = buildPreCallCandidates({
      status: "multiple_matches",
      message: "multiple",
      matches: [
        {
          status: "candidate",
          patientId: "patient-1",
          firstName: "Jane",
          lastName: "Doe",
          dob: "01/01/1980",
        },
        {
          status: "candidate",
          patientId: "patient-2",
          firstName: "Maria",
          lastName: "Doe",
          dob: "02/02/1985",
        },
      ],
    });

    expect(multiple).toMatchObject([
      {
        status: "candidate",
        ref: "precall:1",
        patientId: "patient-1",
        firstName: "Jane",
      },
      {
        status: "candidate",
        ref: "precall:2",
        patientId: "patient-2",
        firstName: "Maria",
      },
    ]);

    expect(
      buildPreCallCandidates({
        status: "lookup_failed",
        phone: "+17275551212",
        reason: "network_error",
        retryable: true,
      }),
    ).toEqual([]);
  });

  it("rejects malformed verified patients nested in multiple matches", async () => {
    usePatientResult({
      status: "multiple_matches",
      matches: [
        verifiedPatient({ dob: null }),
        verifiedPatient({
          patientId: "patient-2",
          name: "Doe, Maria",
          dob: "02/02/1985",
        }),
      ],
    });

    await expect(
      lookupByPhone(middleware, "+17275551212", SPRING_HILL_OFFICE_PHONE),
    ).resolves.toMatchObject({
      status: "lookup_failed",
      reason: "invalid_response",
      retryable: false,
    });
  });

  it("stores full multiple-match patient details in pre-call candidates", async () => {
    usePatientResult({
      status: "multiple_matches",
      matches: [
        verifiedPatient({
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
          preauthRequired: true,
        }),
      ],
    });

    const result = await lookupByPhone(
      middleware,
      "+17275551212",
      SPRING_HILL_OFFICE_PHONE,
    );
    const candidates = buildPreCallCandidates(result);

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
    expect(candidates).toMatchObject([
      {
        ref: "precall:1",
        status: "verified",
        firstName: "Jane",
        lastName: "Doe",
        patientId: "patient-1",
        appointmentsStatus: "found",
        insuranceCarrier: "Aetna",
        routing: "all_three",
        preauthRequired: false,
      },
      {
        ref: "precall:2",
        status: "verified",
        firstName: "Maria",
        lastName: "Doe",
        patientId: "patient-2",
        appointmentsStatus: "none",
        insuranceCarrier: "Humana",
        routing: "bach_only",
        preauthRequired: true,
      },
    ]);
  });

  it("stores lightweight candidates as unresolved private pre-call state", async () => {
    usePatientResult({
      status: "multiple_matches",
      matches: [
        {
          status: "candidate",
          patientId: "private-patient-1",
          firstName: "Jane",
          lastName: "Doe",
          dob: "01/02/1980",
        },
        {
          status: "candidate",
          patientId: "private-patient-2",
          firstName: "Maria",
          lastName: "Doe",
          dob: "02/03/1982",
        },
      ],
    });

    const result = await lookupByPhone(
      middleware,
      "+17275551212",
      SPRING_HILL_OFFICE_PHONE,
    );
    const candidates = buildPreCallCandidates(result);

    expect(result).toEqual({
      status: "multiple_matches",
      message: "Multiple patient matches found.",
      matches: [
        {
          status: "candidate",
          patientId: "private-patient-1",
          firstName: "Jane",
          lastName: "Doe",
          dob: "01/02/1980",
        },
        {
          status: "candidate",
          patientId: "private-patient-2",
          firstName: "Maria",
          lastName: "Doe",
          dob: "02/03/1982",
        },
      ],
    });
    expect(candidates).toMatchObject([
      {
        status: "candidate",
        ref: "precall:1",
        patientId: "private-patient-1",
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/02/1980",
        appointments: [],
      },
      {
        status: "candidate",
        ref: "precall:2",
        patientId: "private-patient-2",
        firstName: "Maria",
        lastName: "Doe",
        dob: "02/03/1982",
        appointments: [],
      },
    ]);
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
      middleware,
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
