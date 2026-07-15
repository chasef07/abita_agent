import { afterEach, describe, expect, it, vi } from "vitest";
import { SPRING_HILL_OFFICE_PHONE } from "../customers/profile.js";
import { lookupByPhone } from "../clients/advancedmd-client.js";
import { loadPreCallBootstrap } from "../runtime/precall-bootstrap.js";

describe("pre-call bootstrap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
      phoneLookup: {
        patientId: "patient-1",
        name: "Doe, Jane",
        appointmentsStatus: "none",
      },
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

  it("stores full multiple-match patient details in pre-call candidates", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          status: "multiple_matches",
          message: "Found 2 patients for this phone number.",
          appointments: [],
          matches: [
            {
              status: "verified",
              patientId: "patient-1",
              name: "Doe, Jane",
              dob: "01/01/1980",
              phone: "+17275551212",
              insuranceCarrier: "Aetna",
              routing: "all_three",
              allowedProviders: ["Dr. Bach"],
              routingAmbiguous: false,
              preauthRequired: false,
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
            },
            {
              status: "verified",
              patientId: "patient-2",
              name: "Doe, Maria",
              dob: "02/02/1985",
              phone: "+17275551212",
              insuranceCarrier: "Humana",
              routing: "bach_only",
              allowedProviders: ["Dr. Bach"],
              routingAmbiguous: false,
              preauthRequired: true,
              appointmentsStatus: "none",
              appointments: [],
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
