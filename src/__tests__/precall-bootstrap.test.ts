import { afterEach, describe, expect, it, vi } from "vitest";
import { SPRING_HILL_OFFICE_PHONE } from "../offices.js";
import { lookupByPhone } from "../tooling/advancedmd-client.js";
import {
  buildPreCallContextState,
  loadPreCallBootstrap,
} from "../tooling/precall-bootstrap.js";

describe("pre-call bootstrap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.FLOW_HARNESS_TRUNK_PHONES;
  });

  it("returns an explicit no_match outcome instead of null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ status: "not_found", message: "No match" }),
        text: async () => "",
      })),
    );

    const result = await lookupByPhone(
      "+17275551212",
      SPRING_HILL_OFFICE_PHONE,
    );

    expect(result).toMatchObject({
      status: "no_match",
      phone: "+17275551212",
      message: "No match",
    });
  });

  it("keeps middleware failures separate from no-match callers", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => "middleware down",
      })),
    );

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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ status: "error", message: "middleware failed" }),
        text: async () => "",
      })),
    );

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
    process.env.FLOW_HARNESS_TRUNK_PHONES = SPRING_HILL_OFFICE_PHONE;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
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
        appointmentsStatus: "none",
        appointments: [],
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const bootstrap = await loadPreCallBootstrap({
      callerPhone: "+17275551212",
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
    });

    expect(bootstrap).toMatchObject({
      office: { key: "spring-hill" },
      verified: {
        patientId: "patient-1",
        name: "Doe, Jane",
        appointmentsStatus: "none",
      },
      flowHarnessEnabled: true,
      telemetry: {
        status: "verified",
      },
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/api/patient/resolve",
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      phone: "+17275551212",
    });
    expect(bootstrap.telemetry.durationMs).toEqual(expect.any(Number));
  });

  it("accepts verified phone lookups when middleware omits echoed phone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          status: "verified",
          patientId: "patient-1",
          name: "Doe, Jane",
          dob: "01/01/1980",
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
        text: async () => "",
      })),
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

  it("maps lookup outcomes into harness-owned pre-call state", () => {
    const single = buildPreCallContextState(
      {
        status: "verified",
        patientId: "patient-1",
        name: "Doe, Jane",
        dob: "01/01/1980",
        phone: "+17275551212",
        insuranceCarrier: null,
        insPlanId: null,
        respPartyId: null,
        routing: null,
        allowedProviders: [],
        routingAmbiguous: false,
        appointmentsStatus: "none",
        appointmentsMessage: null,
        appointments: [],
      },
      "+17275551212",
    );

    expect(single).toMatchObject({
      status: "single_match_pending_confirmation",
      selectedCandidateRef: "caller",
      appointmentLoadStatus: "none",
      candidates: [
        {
          ref: "caller",
          firstName: "Jane",
          lastName: "Doe",
          patientId: "patient-1",
          relationshipToCaller: "self",
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

  it("keeps verified caller context when insurance is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          status: "verified",
          patientId: "patient-1",
          name: "Doe, Jane",
          dob: "01/01/1980",
          phone: "+17275551212",
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
        text: async () => "",
      })),
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
