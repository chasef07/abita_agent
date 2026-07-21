import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEV_OFFICE_PHONE,
  getOfficeProfileByPhone,
  SPRING_HILL_OFFICE_PHONE,
} from "../customers/abita/profile.js";
import {
  HttpOwnedMiddleware,
  InMemoryOwnedMiddleware,
  type AvailabilityResult,
  type BookAppointmentResult,
  type CancelAppointmentResult,
  type CreatePatientResult,
  type OwnedMiddleware,
  type PatientResolveVerified,
  type UpdateInsuranceResult,
} from "../clients/owned-middleware.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const verifiedPatient: PatientResolveVerified = {
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
  preauthRequired: false,
  appointmentsStatus: "none",
  appointmentsMessage: null,
  appointments: [],
  message: null,
};

function patientContractAdapters(): Array<{
  name: string;
  create: () => OwnedMiddleware;
}> {
  return [
    {
      name: "HTTP",
      create: () =>
        new HttpOwnedMiddleware({
          fetch: vi.fn(async () => Response.json(verifiedPatient)),
          productionBaseUrl: "https://middleware.test",
        }),
    },
    {
      name: "in-memory",
      create: () =>
        new InMemoryOwnedMiddleware({
          resolvePatient: [verifiedPatient],
        }),
    },
  ];
}

describe.each(patientContractAdapters())(
  "$name owned middleware",
  ({ create }) => {
    it("returns a verified patient from full identity", async () => {
      const middleware = create();

      const result = await middleware.resolvePatient({
        office: SPRING_HILL_OFFICE_PHONE,
        identity: {
          firstName: "Jane",
          lastName: "Doe",
          dob: "01/01/1980",
        },
      });

      expect(result).toEqual(verifiedPatient);
    });
  },
);

const availabilityFound: AvailabilityResult = {
  status: "found",
  slots: [
    {
      provider: "Dr. Bach",
      date: "2026-08-01",
      time: "9:00 AM",
      datetime: "2026-08-01T09:00:00",
      bookingToken: "booking-token",
    },
  ],
  requestedDate: "2026-08-01",
  actualDate: "2026-08-01",
  searchedFrom: "2026-08-01",
  searchedThrough: "2026-08-01",
  dateShifted: false,
  shouldRetrySameSearch: false,
};

describe.each([
  {
    name: "HTTP",
    create: () =>
      new HttpOwnedMiddleware({
        fetch: vi.fn(async () =>
          Response.json({
            status: "success",
            outcome: "availability_found",
            availabilityFound: true,
            slots: availabilityFound.slots,
            requestedDate: "2026-08-01",
            actualDate: "2026-08-01",
            searchedFrom: "2026-08-01",
            searchedThrough: "2026-08-01",
            dateShifted: false,
            shouldRetrySameSearch: false,
          }),
        ),
        productionBaseUrl: "https://middleware.test",
      }),
  },
  {
    name: "in-memory",
    create: () =>
      new InMemoryOwnedMiddleware({
        getAvailability: [availabilityFound],
      }),
  },
])("$name availability contract", ({ create }) => {
  it("returns typed available slots", async () => {
    const result = await create().getAvailability({
      office: SPRING_HILL_OFFICE_PHONE,
      date: "2026-08-01",
      routing: "all_three",
    });

    expect(result).toEqual(availabilityFound);
  });
});

const updatedInsurance: UpdateInsuranceResult = {
  status: "updated",
  newInsurance: "Aetna",
  routing: "all_three",
  allowedProviders: ["Dr. Bach"],
  routingAmbiguous: false,
  preauthRequired: false,
};

describe.each([
  {
    name: "HTTP",
    create: () =>
      new HttpOwnedMiddleware({
        fetch: vi.fn(async () =>
          Response.json({
            status: "updated",
            newInsurance: "Aetna",
            routing: "all_three",
            allowedProviders: ["Dr. Bach"],
          }),
        ),
        productionBaseUrl: "https://middleware.test",
      }),
  },
  {
    name: "in-memory",
    create: () =>
      new InMemoryOwnedMiddleware({
        updateInsurance: [updatedInsurance],
      }),
  },
])("$name insurance-update contract", ({ create }) => {
  it("returns normalized routing after an insurance update", async () => {
    const result = await create().updateInsurance({
      office: SPRING_HILL_OFFICE_PHONE,
      update: {
        patientId: "patient-1",
        dob: "01/01/1980",
        insPlanId: "plan-1",
        respPartyId: "resp-1",
        oldInsurance: "Self Pay",
        insurance: "Aetna",
        coverageType: "medical",
        subscriberNum: "member-1",
      },
    });

    expect(result).toEqual(updatedInsurance);
  });
});

const cancelledAppointment: CancelAppointmentResult = {
  status: "cancelled",
  message: "Appointment cancelled successfully",
};

describe.each([
  {
    name: "HTTP",
    create: () =>
      new HttpOwnedMiddleware({
        fetch: vi.fn(async () =>
          Response.json({
            status: "cancelled",
            message: "Appointment cancelled successfully",
          }),
        ),
        productionBaseUrl: "https://middleware.test",
      }),
  },
  {
    name: "in-memory",
    create: () =>
      new InMemoryOwnedMiddleware({
        cancelAppointment: [cancelledAppointment],
      }),
  },
])("$name cancellation contract", ({ create }) => {
  it("requires an explicit cancelled outcome", async () => {
    const result = await create().cancelAppointment({
      office: SPRING_HILL_OFFICE_PHONE,
      appointmentId: 12345,
      patientId: "patient-1",
    });

    expect(result).toEqual(cancelledAppointment);
  });
});

const bookedAppointment: BookAppointmentResult = {
  status: "booked",
  appointmentId: 12345,
  appointmentTypeId: 1005,
  providerName: "Dr. Bach",
  locationName: "Spring Hill",
  appointmentTypeName: "Follow-up",
  message: null,
};

describe.each([
  {
    name: "HTTP",
    create: () =>
      new HttpOwnedMiddleware({
        fetch: vi.fn(async () =>
          Response.json({
            status: "booked",
            appointmentId: 12345,
            appointmentTypeId: 1005,
            providerName: "Dr. Bach",
            locationName: "Spring Hill",
            appointmentTypeName: "Follow-up",
          }),
        ),
        productionBaseUrl: "https://middleware.test",
      }),
  },
  {
    name: "in-memory",
    create: () =>
      new InMemoryOwnedMiddleware({
        bookAppointment: [bookedAppointment],
      }),
  },
])("$name booking contract", ({ create }) => {
  it("requires an appointment ID for booking success", async () => {
    const result = await create().bookAppointment({
      office: SPRING_HILL_OFFICE_PHONE,
      booking: {
        bookingToken: "booking-token",
        visitCategory: "medical",
        visitKind: "medical",
        patientStatus: "established",
        visitReason: "blurred vision in left eye",
        patientId: "patient-1",
        appointmentReason: "blurred vision in left eye",
        referringDoctor: "none",
        routing: "all_three",
      },
    });

    expect(result).toEqual(bookedAppointment);
  });
});

const createdPatient: CreatePatientResult = {
  status: "created",
  patientId: "patient-2",
  name: "Jane Doe",
  phone: "+17275551212",
  insuranceCarrier: "Aetna",
  insPlanId: null,
  respPartyId: null,
  routing: "all_three",
  allowedProviders: [],
  routingAmbiguous: false,
  preauthRequired: false,
};

describe.each([
  {
    name: "HTTP",
    create: () =>
      new HttpOwnedMiddleware({
        fetch: vi.fn(async () =>
          Response.json({
            patientId: "patient-2",
            name: "Jane Doe",
            phone: "+17275551212",
            insuranceCarrier: "Aetna",
            routing: "all_three",
          }),
        ),
        productionBaseUrl: "https://middleware.test",
      }),
  },
  {
    name: "in-memory",
    create: () =>
      new InMemoryOwnedMiddleware({
        createPatient: [createdPatient],
      }),
  },
])("$name chart-creation contract", ({ create }) => {
  it("requires patient evidence for chart creation success", async () => {
    const result = await create().createPatient({
      office: SPRING_HILL_OFFICE_PHONE,
      patient: {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        street: "1 Main Street",
        aptSuite: "",
        city: "Spring Hill",
        state: "FL",
        zip: "34609",
        sex: "female",
        insurance: "Aetna",
        phone: "+17275551212",
        subscriberName: "Jane Doe",
        subscriberNum: "member-1",
      },
    });

    expect(result).toEqual(createdPatient);
  });
});

describe("HTTP owned middleware transport", () => {
  it("owns all six endpoints, request serialization, authorization, and timeout", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(verifiedPatient))
      .mockResolvedValueOnce(Response.json(availabilityFound))
      .mockResolvedValueOnce(Response.json(createdPatient))
      .mockResolvedValueOnce(Response.json(bookedAppointment))
      .mockResolvedValueOnce(Response.json(cancelledAppointment))
      .mockResolvedValueOnce(Response.json(updatedInsurance));
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const middleware = new HttpOwnedMiddleware({
      authToken: "test-token",
      fetch: fetchMock,
      productionBaseUrl: "https://middleware.test/",
      timeoutMs: 10_000,
    });

    await middleware.resolvePatient({
      office: SPRING_HILL_OFFICE_PHONE,
      identity: { phone: "+17275551212" },
      fallbackPhone: "+17275551212",
    });
    await middleware.getAvailability({
      office: SPRING_HILL_OFFICE_PHONE,
      date: "2026-08-01",
      dob: "01/01/1980",
      routing: "all_three",
      preauthRequired: true,
    });
    await middleware.createPatient({
      office: SPRING_HILL_OFFICE_PHONE,
      patient: {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        street: "1 Main Street",
        aptSuite: "",
        city: "Spring Hill",
        state: "FL",
        zip: "34609",
        sex: "female",
        insurance: "Aetna",
        phone: "+17275551212",
        subscriberName: "Jane Doe",
        subscriberNum: "member-1",
      },
    });
    await middleware.bookAppointment({
      office: SPRING_HILL_OFFICE_PHONE,
      booking: {
        bookingToken: "booking-token",
        visitCategory: "medical",
        visitKind: "medical",
        patientStatus: "established",
        patientId: "patient-1",
        appointmentReason: "blurred vision in left eye",
        referringDoctor: "none",
      },
    });
    await middleware.cancelAppointment({
      office: SPRING_HILL_OFFICE_PHONE,
      appointmentId: 12345,
      patientId: "patient-1",
    });
    await middleware.updateInsurance({
      office: SPRING_HILL_OFFICE_PHONE,
      update: {
        patientId: "patient-1",
        dob: "01/01/1980",
        insPlanId: "plan-1",
        respPartyId: "resp-1",
        oldInsurance: "Self Pay",
        insurance: "Aetna",
        coverageType: "medical",
        subscriberNum: "member-1",
      },
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://middleware.test/api/patient/resolve",
      "https://middleware.test/api/scheduler/availability",
      "https://middleware.test/api/add-patient",
      "https://middleware.test/api/appointment/book",
      "https://middleware.test/api/appointment/cancel",
      "https://middleware.test/api/patient/update-insurance",
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        Authorization: "test-token",
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      phone: "+17275551212",
      office: SPRING_HILL_OFFICE_PHONE,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      date: "2026-08-01",
      dob: "01/01/1980",
      routing: "all_three",
      preauthRequired: true,
      office: SPRING_HILL_OFFICE_PHONE,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      firstName: "Jane",
      lastName: "Doe",
      dob: "01/01/1980",
      street: "1 Main Street",
      aptSuite: "",
      city: "Spring Hill",
      state: "FL",
      zip: "34609",
      sex: "female",
      insurance: "Aetna",
      phone: "+17275551212",
      subscriberName: "Jane Doe",
      subscriberNum: "member-1",
      office: SPRING_HILL_OFFICE_PHONE,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({
      bookingToken: "booking-token",
      visitCategory: "medical",
      visitKind: "medical",
      patientStatus: "established",
      patientId: "patient-1",
      appointmentReason: "blurred vision in left eye",
      referringDoctor: "none",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body))).toEqual({
      appointmentId: 12345,
      patientId: "patient-1",
      office: SPRING_HILL_OFFICE_PHONE,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[5]?.[1]?.body))).toEqual({
      patientId: "patient-1",
      dob: "01/01/1980",
      insPlanId: "plan-1",
      respPartyId: "resp-1",
      oldInsurance: "Self Pay",
      insurance: "Aetna",
      coverageType: "medical",
      subscriberNum: "member-1",
      office: SPRING_HILL_OFFICE_PHONE,
    });
    expect(timeoutSpy).toHaveBeenCalledTimes(6);
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
  });

  it("selects the configured development URL without changing production routing", async () => {
    const fetchMock = vi.fn(async () => Response.json(verifiedPatient));
    const middleware = new HttpOwnedMiddleware({
      fetch: fetchMock,
      productionBaseUrl: "https://middleware.test",
    });

    await middleware.resolvePatient({
      office: SPRING_HILL_OFFICE_PHONE,
      identity: { phone: "+17275551212" },
    });
    await middleware.resolvePatient({
      office: DEV_OFFICE_PHONE,
      identity: { phone: "+17275551212" },
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://middleware.test/api/patient/resolve",
      `${getOfficeProfileByPhone(DEV_OFFICE_PHONE).middlewareBaseUrl("https://middleware.test")}/api/patient/resolve`,
    ]);
  });

  it.each([
    {
      name: "middleware failure",
      fetch: vi.fn(
        async () => new Response("private backend detail", { status: 503 }),
      ),
      office: SPRING_HILL_OFFICE_PHONE,
      expectedReason: "middleware_error",
    },
    {
      name: "network failure",
      fetch: vi.fn(async () => {
        throw new TypeError("private host failed");
      }),
      office: SPRING_HILL_OFFICE_PHONE,
      expectedReason: "network_error",
    },
    {
      name: "invalid response",
      fetch: vi.fn(async () => new Response("{", { status: 200 })),
      office: SPRING_HILL_OFFICE_PHONE,
      expectedReason: "invalid_response",
    },
    {
      name: "unsupported office",
      fetch: vi.fn(),
      office: "+19999999999",
      expectedReason: "unsupported_office",
    },
  ])("normalizes $name without exposing transport detail", async (testCase) => {
    const middleware = new HttpOwnedMiddleware({
      fetch: testCase.fetch,
      productionBaseUrl: "https://middleware.test",
    });

    const result = await middleware.getAvailability({
      office: testCase.office,
      date: "2026-08-01",
    });

    expect(result).toMatchObject({
      status: "error",
      reason: testCase.expectedReason,
    });
    expect(result).not.toHaveProperty("message");
  });

  it("distinguishes caller cancellation from transport failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const middleware = new HttpOwnedMiddleware({
      fetch: vi.fn(async (_url, init) => {
        if (init?.signal?.aborted) throw init.signal.reason;
        return Response.json({});
      }),
      productionBaseUrl: "https://middleware.test",
    });

    const result = await middleware.getAvailability({
      office: SPRING_HILL_OFFICE_PHONE,
      date: "2026-08-01",
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      status: "error",
      reason: "cancelled",
    });
  });

  it("rejects malformed availability slots at the adapter boundary", async () => {
    const middleware = new HttpOwnedMiddleware({
      fetch: vi.fn(async () =>
        Response.json({
          outcome: "availability_found",
          slots: [{ date: "2026-08-01", time: "9:00 AM" }],
        }),
      ),
      productionBaseUrl: "https://middleware.test",
    });

    const result = await middleware.getAvailability({
      office: SPRING_HILL_OFFICE_PHONE,
      date: "2026-08-01",
    });

    expect(result).toEqual({
      status: "error",
      reason: "invalid_response",
    });
  });

  it("derives the slot date from the middleware datetime", async () => {
    const middleware = new HttpOwnedMiddleware({
      fetch: vi.fn(async () =>
        Response.json({
          status: "success",
          outcome: "availability_found",
          slots: [
            {
              provider: "Dr. Bach",
              time: "9:00 AM",
              datetime: "2026-08-01T09:00:00",
              bookingToken: "booking-token",
              columnId: 1513,
              profileId: 620,
              duration: 30,
            },
          ],
        }),
      ),
      productionBaseUrl: "https://middleware.test",
    });

    const result = await middleware.getAvailability({
      office: SPRING_HILL_OFFICE_PHONE,
      date: "2026-08-01",
    });

    expect(result).toMatchObject({
      status: "found",
      slots: [
        {
          provider: "Dr. Bach",
          date: "2026-08-01",
          time: "9:00 AM",
          datetime: "2026-08-01T09:00:00",
          bookingToken: "booking-token",
        },
      ],
    });
  });

  it("normalizes no eligible providers as no availability", async () => {
    const middleware = new HttpOwnedMiddleware({
      fetch: vi.fn(async () =>
        Response.json({
          status: "success",
          outcome: "no_eligible_providers",
          requestedDate: "2026-08-01",
          shouldRetrySameSearch: false,
          slots: [],
        }),
      ),
      productionBaseUrl: "https://middleware.test",
    });

    const result = await middleware.getAvailability({
      office: SPRING_HILL_OFFICE_PHONE,
      date: "2026-08-01",
    });

    expect(result).toMatchObject({
      status: "none",
      slots: [],
      requestedDate: "2026-08-01",
      shouldRetrySameSearch: false,
    });
  });

  it("rejects unknown availability outcomes at the adapter boundary", async () => {
    const middleware = new HttpOwnedMiddleware({
      fetch: vi.fn(async () =>
        Response.json({ outcome: "schema_drift", slots: [] }),
      ),
      productionBaseUrl: "https://middleware.test",
    });

    await expect(
      middleware.getAvailability({
        office: SPRING_HILL_OFFICE_PHONE,
        date: "2026-08-01",
      }),
    ).resolves.toEqual({
      status: "error",
      reason: "invalid_response",
    });
  });

  it("honors an explicit patient lookup error even when a patient ID is present", async () => {
    const middleware = new HttpOwnedMiddleware({
      fetch: vi.fn(async () =>
        Response.json({
          status: "error",
          patientId: "stale-patient-id",
          message: "private detail",
        }),
      ),
      productionBaseUrl: "https://middleware.test",
    });

    const result = await middleware.resolvePatient({
      office: SPRING_HILL_OFFICE_PHONE,
      identity: { phone: "+17275551212" },
    });

    expect(result).toEqual({
      status: "error",
      reason: "middleware_error",
    });
  });

  it("rejects malformed appointment records at the patient adapter boundary", async () => {
    const middleware = new HttpOwnedMiddleware({
      fetch: vi.fn(async () =>
        Response.json({
          ...verifiedPatient,
          appointmentsStatus: "found",
          appointments: [
            {
              id: 12345,
              date: "2026-08-01",
              time: "9:00 AM",
              provider: "Dr. Bach",
              type: "Follow-up",
              facility: "Spring Hill",
              confirmed: "true",
            },
          ],
        }),
      ),
      productionBaseUrl: "https://middleware.test",
    });

    const result = await middleware.resolvePatient({
      office: SPRING_HILL_OFFICE_PHONE,
      identity: { phone: "+17275551212" },
    });

    expect(result).toEqual({
      status: "error",
      reason: "invalid_response",
    });
  });

  it("rejects multiple-match outcomes without valid matches", async () => {
    const middleware = new HttpOwnedMiddleware({
      fetch: vi.fn(async () =>
        Response.json({ status: "multiple_matches", matches: null }),
      ),
      productionBaseUrl: "https://middleware.test",
    });

    await expect(
      middleware.resolvePatient({
        office: SPRING_HILL_OFFICE_PHONE,
        identity: { phone: "+17275551212" },
      }),
    ).resolves.toEqual({
      status: "error",
      reason: "invalid_response",
    });
  });

  it("rejects unknown chart-creation statuses even with a patient ID", async () => {
    const middleware = new HttpOwnedMiddleware({
      fetch: vi.fn(async () =>
        Response.json({ status: "schema_drift", patientId: "patient-2" }),
      ),
      productionBaseUrl: "https://middleware.test",
    });

    await expect(
      middleware.createPatient({
        office: SPRING_HILL_OFFICE_PHONE,
        patient: {
          firstName: "Jane",
          lastName: "Doe",
          dob: "01/01/1980",
          street: "1 Main Street",
          aptSuite: "",
          city: "Spring Hill",
          state: "FL",
          zip: "34609",
          sex: "female",
          insurance: "Aetna",
          phone: "+17275551212",
          subscriberName: "Jane Doe",
          subscriberNum: "member-1",
        },
      }),
    ).resolves.toEqual({
      status: "error",
      reason: "invalid_response",
    });
  });

  it.each([
    {
      name: "patient lookup",
      call: (middleware: HttpOwnedMiddleware) =>
        middleware.resolvePatient({
          office: SPRING_HILL_OFFICE_PHONE,
          identity: { phone: "+17275551212" },
        }),
    },
    {
      name: "availability",
      call: (middleware: HttpOwnedMiddleware) =>
        middleware.getAvailability({
          office: SPRING_HILL_OFFICE_PHONE,
          date: "2026-08-01",
        }),
    },
    {
      name: "chart creation",
      call: (middleware: HttpOwnedMiddleware) =>
        middleware.createPatient({
          office: SPRING_HILL_OFFICE_PHONE,
          patient: {
            firstName: "Jane",
            lastName: "Doe",
            dob: "01/01/1980",
            street: "1 Main Street",
            aptSuite: "",
            city: "Spring Hill",
            state: "FL",
            zip: "34609",
            sex: "female",
            insurance: "Aetna",
            phone: "+17275551212",
            subscriberName: "Jane Doe",
            subscriberNum: "member-1",
          },
        }),
    },
    {
      name: "booking",
      call: (middleware: HttpOwnedMiddleware) =>
        middleware.bookAppointment({
          office: SPRING_HILL_OFFICE_PHONE,
          booking: {
            bookingToken: "booking-token",
            visitCategory: "medical",
            visitKind: "medical",
            patientStatus: "established",
            patientId: "patient-1",
            appointmentReason: "blurred vision",
            referringDoctor: "none",
          },
        }),
    },
    {
      name: "cancellation",
      call: (middleware: HttpOwnedMiddleware) =>
        middleware.cancelAppointment({
          office: SPRING_HILL_OFFICE_PHONE,
          appointmentId: 12345,
          patientId: "patient-1",
        }),
    },
    {
      name: "insurance update",
      call: (middleware: HttpOwnedMiddleware) =>
        middleware.updateInsurance({
          office: SPRING_HILL_OFFICE_PHONE,
          update: {
            patientId: "patient-1",
            insPlanId: "plan-1",
            respPartyId: "resp-1",
            oldInsurance: "Self Pay",
            insurance: "Aetna",
            coverageType: "medical",
            subscriberNum: "member-1",
          },
        }),
    },
  ])("sanitizes semantic $name failure bodies", async ({ call }) => {
    const middleware = new HttpOwnedMiddleware({
      fetch: vi.fn(async () =>
        Response.json({
          status: "error",
          message: "private patient and backend detail",
        }),
      ),
      productionBaseUrl: "https://middleware.test",
    });

    const result = await call(middleware);

    expect(result).toEqual({
      status: "error",
      reason: "middleware_error",
    });
  });

  it.each([
    {
      outcome: "no_availability",
      expectedStatus: "none",
    },
    {
      outcome: "availability_search_incomplete",
      expectedStatus: "incomplete",
    },
  ])("normalizes $outcome availability", async (testCase) => {
    const middleware = new HttpOwnedMiddleware({
      fetch: vi.fn(async () =>
        Response.json({
          outcome: testCase.outcome,
          slots: [],
          shouldRetrySameSearch: testCase.expectedStatus === "incomplete",
        }),
      ),
      productionBaseUrl: "https://middleware.test",
    });

    const result = await middleware.getAvailability({
      office: SPRING_HILL_OFFICE_PHONE,
      date: "2026-08-01",
    });

    expect(result).toMatchObject({
      status: testCase.expectedStatus,
      slots: [],
    });
  });

  it("normalizes patient lookup alternatives", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          status: "multiple_matches",
          matches: [verifiedPatient, { firstName: "Maria" }],
        }),
      )
      .mockResolvedValueOnce(Response.json({ status: "not_found" }))
      .mockResolvedValueOnce(Response.json({ unexpected: true }));
    const middleware = new HttpOwnedMiddleware({
      fetch: fetchMock,
      productionBaseUrl: "https://middleware.test",
    });
    const request = {
      office: SPRING_HILL_OFFICE_PHONE,
      identity: { phone: "+17275551212" } as const,
    };

    await expect(middleware.resolvePatient(request)).resolves.toMatchObject({
      status: "multiple_matches",
      matches: [verifiedPatient, { firstName: "Maria" }],
    });
    await expect(middleware.resolvePatient(request)).resolves.toMatchObject({
      status: "not_found",
    });
    await expect(middleware.resolvePatient(request)).resolves.toEqual({
      status: "error",
      reason: "invalid_response",
    });
  });

  it.each([
    {
      name: "network failure",
      office: SPRING_HILL_OFFICE_PHONE,
      fetch: vi.fn(async () => {
        throw new TypeError("private network detail");
      }),
      reason: "network_error",
    },
    {
      name: "unsupported office",
      office: "+19999999999",
      fetch: vi.fn(),
      reason: "unsupported_office",
    },
  ])("normalizes patient $name", async (testCase) => {
    const middleware = new HttpOwnedMiddleware({
      fetch: testCase.fetch,
      productionBaseUrl: "https://middleware.test",
    });

    const result = await middleware.resolvePatient({
      office: testCase.office,
      identity: { phone: "+17275551212" },
    });

    expect(result).toEqual({
      status: "error",
      reason: testCase.reason,
    });
  });

  it("normalizes booking partial, unavailable, and missing-evidence outcomes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          status: "partial",
          appointmentId: 12345,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          status: "error",
          outcome: "slot_unavailable",
          message: "private backend detail",
        }),
      )
      .mockResolvedValueOnce(Response.json({ status: "booked" }));
    const middleware = new HttpOwnedMiddleware({
      fetch: fetchMock,
      productionBaseUrl: "https://middleware.test",
    });
    const request = {
      office: SPRING_HILL_OFFICE_PHONE,
      booking: {
        bookingToken: "booking-token",
        visitCategory: "medical" as const,
        visitKind: "medical" as const,
        patientStatus: "established" as const,
        patientId: "patient-1",
        appointmentReason: "blurred vision",
        referringDoctor: "none",
      },
    };

    await expect(middleware.bookAppointment(request)).resolves.toMatchObject({
      status: "partial",
      appointmentId: 12345,
    });
    await expect(middleware.bookAppointment(request)).resolves.toEqual({
      status: "unavailable",
      reason: "slot_unavailable",
    });
    await expect(middleware.bookAppointment(request)).resolves.toEqual({
      status: "error",
      reason: "invalid_response",
      detail: "missing_appointment_id",
    });
  });

  it("rejects unexpected chart, cancellation, and insurance records", async () => {
    const middleware = new HttpOwnedMiddleware({
      fetch: vi.fn(async () => Response.json({ unexpected: true })),
      productionBaseUrl: "https://middleware.test",
    });

    await expect(
      middleware.createPatient({
        office: SPRING_HILL_OFFICE_PHONE,
        patient: {
          firstName: "Jane",
          lastName: "Doe",
          dob: "01/01/1980",
          street: "1 Main Street",
          aptSuite: "",
          city: "Spring Hill",
          state: "FL",
          zip: "34609",
          sex: "female",
          insurance: "Aetna",
          phone: "+17275551212",
          subscriberName: "Jane Doe",
          subscriberNum: "member-1",
        },
      }),
    ).resolves.toEqual({
      status: "error",
      reason: "invalid_response",
    });
    await expect(
      middleware.cancelAppointment({
        office: SPRING_HILL_OFFICE_PHONE,
        appointmentId: 12345,
        patientId: "patient-1",
      }),
    ).resolves.toEqual({
      status: "error",
      reason: "invalid_response",
    });
    await expect(
      middleware.updateInsurance({
        office: SPRING_HILL_OFFICE_PHONE,
        update: {
          patientId: "patient-1",
          insPlanId: "plan-1",
          respPartyId: "resp-1",
          oldInsurance: "Self Pay",
          insurance: "Aetna",
          coverageType: "medical",
          subscriberNum: "member-1",
        },
      }),
    ).resolves.toEqual({
      status: "error",
      reason: "invalid_response",
    });
  });
});

type SemanticContractCase = {
  name: string;
  http: () => OwnedMiddleware;
  memory: () => OwnedMiddleware;
  invoke: (middleware: OwnedMiddleware) => Promise<unknown>;
  expected: unknown;
};

function httpResult(raw: unknown): () => OwnedMiddleware {
  return () =>
    new HttpOwnedMiddleware({
      fetch: vi.fn(async () => Response.json(raw)),
      productionBaseUrl: "https://middleware.test",
    });
}

function httpFailure(error: Error): () => OwnedMiddleware {
  return () =>
    new HttpOwnedMiddleware({
      fetch: vi.fn(async () => {
        throw error;
      }),
      productionBaseUrl: "https://middleware.test",
    });
}

function memoryResult(
  responses: InMemoryOwnedMiddlewareResponses,
): () => OwnedMiddleware {
  return () => new InMemoryOwnedMiddleware(responses);
}

const patientLookup = (
  middleware: OwnedMiddleware,
  office = SPRING_HILL_OFFICE_PHONE,
) =>
  middleware.resolvePatient({
    office,
    identity: { phone: "+17275551212" },
  });

const availabilityLookup = (middleware: OwnedMiddleware) =>
  middleware.getAvailability({
    office: SPRING_HILL_OFFICE_PHONE,
    date: "2026-08-01",
  });

const createPatient = (middleware: OwnedMiddleware) =>
  middleware.createPatient({
    office: SPRING_HILL_OFFICE_PHONE,
    patient: {
      firstName: "Jane",
      lastName: "Doe",
      dob: "01/01/1980",
      street: "1 Main Street",
      aptSuite: "",
      city: "Spring Hill",
      state: "FL",
      zip: "34609",
      sex: "female",
      insurance: "Aetna",
      phone: "+17275551212",
      subscriberName: "Jane Doe",
      subscriberNum: "member-1",
    },
  });

const bookAppointment = (middleware: OwnedMiddleware) =>
  middleware.bookAppointment({
    office: SPRING_HILL_OFFICE_PHONE,
    booking: {
      bookingToken: "booking-token",
      visitCategory: "medical",
      visitKind: "medical",
      patientStatus: "established",
      patientId: "patient-1",
      appointmentReason: "blurred vision",
      referringDoctor: "none",
    },
  });

const cancelAppointment = (middleware: OwnedMiddleware) =>
  middleware.cancelAppointment({
    office: SPRING_HILL_OFFICE_PHONE,
    appointmentId: 12345,
    patientId: "patient-1",
  });

const updateInsurance = (middleware: OwnedMiddleware) =>
  middleware.updateInsurance({
    office: SPRING_HILL_OFFICE_PHONE,
    update: {
      patientId: "patient-1",
      insPlanId: "plan-1",
      respPartyId: "resp-1",
      oldInsurance: "Self Pay",
      insurance: "Aetna",
      coverageType: "medical",
      subscriberNum: "member-1",
    },
  });

const semanticFailure = (
  reason:
    | "middleware_error"
    | "network_error"
    | "invalid_response"
    | "unsupported_office"
    | "cancelled",
  detail?: "missing_appointment_id",
) =>
  ({
    status: "error",
    reason,
    ...(detail ? { detail } : {}),
  }) as const;

const semanticContractCases: SemanticContractCase[] = [
  {
    name: "patient multiple matches",
    http: httpResult({
      status: "multiple_matches",
      matches: [verifiedPatient, { firstName: "Maria" }],
    }),
    memory: memoryResult({
      resolvePatient: [
        {
          status: "multiple_matches",
          matches: [verifiedPatient, { firstName: "Maria" }],
        },
      ],
    }),
    invoke: patientLookup,
    expected: expect.objectContaining({
      status: "multiple_matches",
      matches: [verifiedPatient, { firstName: "Maria" }],
    }),
  },
  {
    name: "patient not found",
    http: httpResult({ status: "not_found" }),
    memory: memoryResult({
      resolvePatient: [{ status: "not_found" }],
    }),
    invoke: patientLookup,
    expected: {
      status: "not_found",
    },
  },
  {
    name: "patient middleware failure",
    http: httpResult({ status: "error", message: "private detail" }),
    memory: memoryResult({
      resolvePatient: [semanticFailure("middleware_error")],
    }),
    invoke: patientLookup,
    expected: semanticFailure("middleware_error"),
  },
  {
    name: "patient network failure",
    http: httpFailure(new TypeError("private network detail")),
    memory: memoryResult({
      resolvePatient: [semanticFailure("network_error")],
    }),
    invoke: patientLookup,
    expected: semanticFailure("network_error"),
  },
  {
    name: "patient invalid response",
    http: httpResult({ unexpected: true }),
    memory: memoryResult({
      resolvePatient: [semanticFailure("invalid_response")],
    }),
    invoke: patientLookup,
    expected: semanticFailure("invalid_response"),
  },
  {
    name: "patient unsupported office",
    http: httpResult(verifiedPatient),
    memory: memoryResult({
      resolvePatient: [semanticFailure("unsupported_office")],
    }),
    invoke: (middleware) => patientLookup(middleware, "+19999999999"),
    expected: semanticFailure("unsupported_office"),
  },
  {
    name: "no availability",
    http: httpResult({ outcome: "no_availability", slots: [] }),
    memory: memoryResult({
      getAvailability: [
        {
          status: "none",
          slots: [],
          dateShifted: false,
          shouldRetrySameSearch: false,
        },
      ],
    }),
    invoke: availabilityLookup,
    expected: expect.objectContaining({ status: "none", slots: [] }),
  },
  {
    name: "incomplete availability",
    http: httpResult({
      outcome: "availability_search_incomplete",
      slots: [],
      shouldRetrySameSearch: true,
    }),
    memory: memoryResult({
      getAvailability: [
        {
          status: "incomplete",
          slots: [],
          dateShifted: false,
          shouldRetrySameSearch: true,
        },
      ],
    }),
    invoke: availabilityLookup,
    expected: expect.objectContaining({
      status: "incomplete",
      slots: [],
      shouldRetrySameSearch: true,
    }),
  },
  {
    name: "invalid availability",
    http: httpResult({ outcome: "availability_found", slots: [{}] }),
    memory: memoryResult({
      getAvailability: [semanticFailure("invalid_response")],
    }),
    invoke: availabilityLookup,
    expected: semanticFailure("invalid_response"),
  },
  {
    name: "availability transport failure",
    http: () =>
      new HttpOwnedMiddleware({
        fetch: vi.fn(async () => new Response(null, { status: 503 })),
        productionBaseUrl: "https://middleware.test",
      }),
    memory: memoryResult({
      getAvailability: [semanticFailure("middleware_error")],
    }),
    invoke: availabilityLookup,
    expected: semanticFailure("middleware_error"),
  },
  {
    name: "availability caller cancellation",
    http: () =>
      new HttpOwnedMiddleware({
        fetch: vi.fn(async (_url, init) => {
          if (init?.signal?.aborted) throw init.signal.reason;
          return Response.json({});
        }),
        productionBaseUrl: "https://middleware.test",
      }),
    memory: memoryResult({
      getAvailability: [semanticFailure("cancelled")],
    }),
    invoke: (middleware) => {
      const controller = new AbortController();
      controller.abort();
      return middleware.getAvailability({
        office: SPRING_HILL_OFFICE_PHONE,
        date: "2026-08-01",
        signal: controller.signal,
      });
    },
    expected: semanticFailure("cancelled"),
  },
  {
    name: "chart creation failure",
    http: httpResult({ status: "error", message: "private detail" }),
    memory: memoryResult({
      createPatient: [semanticFailure("middleware_error")],
    }),
    invoke: createPatient,
    expected: semanticFailure("middleware_error"),
  },
  {
    name: "invalid chart response",
    http: httpResult({ unexpected: true }),
    memory: memoryResult({
      createPatient: [semanticFailure("invalid_response")],
    }),
    invoke: createPatient,
    expected: semanticFailure("invalid_response"),
  },
  {
    name: "partial booking",
    http: httpResult({ status: "partial", appointmentId: 12345 }),
    memory: memoryResult({
      bookAppointment: [{ ...bookedAppointment, status: "partial" }],
    }),
    invoke: bookAppointment,
    expected: expect.objectContaining({
      status: "partial",
      appointmentId: 12345,
    }),
  },
  {
    name: "unavailable booking",
    http: httpResult({
      status: "error",
      outcome: "slot_unavailable",
      message: "private detail",
    }),
    memory: memoryResult({
      bookAppointment: [
        {
          status: "unavailable",
          reason: "slot_unavailable",
        },
      ],
    }),
    invoke: bookAppointment,
    expected: {
      status: "unavailable",
      reason: "slot_unavailable",
    },
  },
  {
    name: "booking missing evidence",
    http: httpResult({ status: "booked" }),
    memory: memoryResult({
      bookAppointment: [
        semanticFailure("invalid_response", "missing_appointment_id"),
      ],
    }),
    invoke: bookAppointment,
    expected: semanticFailure("invalid_response", "missing_appointment_id"),
  },
  {
    name: "booking middleware failure",
    http: httpResult({ status: "error", message: "private detail" }),
    memory: memoryResult({
      bookAppointment: [semanticFailure("middleware_error")],
    }),
    invoke: bookAppointment,
    expected: semanticFailure("middleware_error"),
  },
  {
    name: "cancellation failure",
    http: httpResult({ status: "error", message: "private detail" }),
    memory: memoryResult({
      cancelAppointment: [semanticFailure("middleware_error")],
    }),
    invoke: cancelAppointment,
    expected: semanticFailure("middleware_error"),
  },
  {
    name: "invalid cancellation response",
    http: httpResult({ unexpected: true }),
    memory: memoryResult({
      cancelAppointment: [semanticFailure("invalid_response")],
    }),
    invoke: cancelAppointment,
    expected: semanticFailure("invalid_response"),
  },
  {
    name: "insurance update failure",
    http: httpResult({ status: "error", message: "private detail" }),
    memory: memoryResult({
      updateInsurance: [semanticFailure("middleware_error")],
    }),
    invoke: updateInsurance,
    expected: semanticFailure("middleware_error"),
  },
  {
    name: "invalid insurance update response",
    http: httpResult({ unexpected: true }),
    memory: memoryResult({
      updateInsurance: [semanticFailure("invalid_response")],
    }),
    invoke: updateInsurance,
    expected: semanticFailure("invalid_response"),
  },
];

describe.each([
  {
    adapter: "HTTP",
    create: (testCase: SemanticContractCase) => testCase.http(),
  },
  {
    adapter: "in-memory",
    create: (testCase: SemanticContractCase) => testCase.memory(),
  },
])("$adapter semantic contract matrix", ({ create }) => {
  it.each(semanticContractCases)("$name", async (testCase) => {
    await expect(testCase.invoke(create(testCase))).resolves.toEqual(
      testCase.expected,
    );
  });
});

describe("in-memory owned middleware", () => {
  it("returns normalized outcomes and records all six semantic operations", async () => {
    const middleware = new InMemoryOwnedMiddleware({
      resolvePatient: [verifiedPatient],
      getAvailability: [availabilityFound],
      createPatient: [createdPatient],
      bookAppointment: [bookedAppointment],
      cancelAppointment: [cancelledAppointment],
      updateInsurance: [updatedInsurance],
    });
    const patientRequest = {
      office: SPRING_HILL_OFFICE_PHONE,
      identity: {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
      },
    } as const;

    await expect(middleware.resolvePatient(patientRequest)).resolves.toEqual(
      verifiedPatient,
    );
    await expect(
      middleware.getAvailability({
        office: SPRING_HILL_OFFICE_PHONE,
        date: "2026-08-01",
      }),
    ).resolves.toEqual(availabilityFound);
    await expect(
      middleware.createPatient({
        office: SPRING_HILL_OFFICE_PHONE,
        patient: {
          firstName: "Jane",
          lastName: "Doe",
          dob: "01/01/1980",
          street: "1 Main Street",
          aptSuite: "",
          city: "Spring Hill",
          state: "FL",
          zip: "34609",
          sex: "female",
          insurance: "Aetna",
          phone: "+17275551212",
          subscriberName: "Jane Doe",
          subscriberNum: "member-1",
        },
      }),
    ).resolves.toEqual(createdPatient);
    await expect(
      middleware.bookAppointment({
        office: SPRING_HILL_OFFICE_PHONE,
        booking: {
          bookingToken: "booking-token",
          visitCategory: "medical",
          visitKind: "medical",
          patientStatus: "established",
          patientId: "patient-1",
          appointmentReason: "blurred vision",
          referringDoctor: "none",
        },
      }),
    ).resolves.toEqual(bookedAppointment);
    await expect(
      middleware.cancelAppointment({
        office: SPRING_HILL_OFFICE_PHONE,
        appointmentId: 12345,
        patientId: "patient-1",
      }),
    ).resolves.toEqual(cancelledAppointment);
    await expect(
      middleware.updateInsurance({
        office: SPRING_HILL_OFFICE_PHONE,
        update: {
          patientId: "patient-1",
          insPlanId: "plan-1",
          respPartyId: "resp-1",
          oldInsurance: "Self Pay",
          insurance: "Aetna",
          coverageType: "medical",
          subscriberNum: "member-1",
        },
      }),
    ).resolves.toEqual(updatedInsurance);

    expect(middleware.requests.resolvePatient).toEqual([patientRequest]);
    expect(middleware.operations.map(({ name }) => name)).toEqual([
      "resolvePatient",
      "getAvailability",
      "createPatient",
      "bookAppointment",
      "cancelAppointment",
      "updateInsurance",
    ]);
  });
});
