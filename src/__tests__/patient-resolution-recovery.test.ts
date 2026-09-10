import { candidateSearchResult } from "./support/owned-middleware.js";
import { describe, expect, it, vi } from "vitest";
import { HttpOwnedMiddleware } from "../clients/owned-middleware.js";
import {
  resolveExistingPatient,
  beginNewPatientRegistration,
} from "../identity/patient-identity.js";
import {
  createTestCallState,
  createConfirmedPatientState,
} from "./support/call-state.js";

const candidate = (
  patientId = "one",
  lastName = "Meyer",
  dob = "01/01/1980",
) => ({
  status: "verified" as const,
  ref: patientId,
  patientId,
  firstName: "Jane",
  lastName,
  dob,
  appointments: [],
  appointmentsStatus: "none" as const,
});
const receipt = (
  name = "Jane Meyer",
  dob = "01/01/1980",
  patientId = "one",
) => ({
  status: "verified" as const,
  patientId,
  name,
  dob,
  phone: null,
  insuranceCarrier: null,
  insPlanId: null,
  respPartyId: null,
  routing: null,
  allowedProviders: [],
  routingAmbiguous: false,
  preauthRequired: false,
  appointmentsStatus: "none" as const,
  appointmentsMessage: null,
  appointments: [],
  message: null,
});
const fullIdentity = {
  firstName: "Jane",
  lastName: "Meyer",
  dob: "01/01/1980",
};

describe("audited patient recovery", () => {
  it("asks DOB before surname and keeps distinct first-name/DOB matches ambiguous", async () => {
    const state = createTestCallState({
      preCallCandidates: [candidate(), candidate("two", "Smith")],
    });
    const lookup = vi.fn();
    expect(
      (await resolveExistingPatient(state, { firstName: "Jane" }, lookup))
        .reply,
    ).toContain("date of birth");
    const collision = await resolveExistingPatient(
      state,
      { dob: "01/01/1980" },
      lookup,
    );
    expect(collision.outcome).toBe("multiple_matches");
    expect(collision.reply).toContain("last name");
    expect(state.identity.activePatient).toBeNull();
    expect(
      (await resolveExistingPatient(state, { lastName: "Meyr" }, lookup))
        .outcome,
    ).toBe("verified");
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(["not_found", "multiple_matches"] as const)(
    "reuses unchanged %s without another backend read",
    async (status) => {
      const state = createTestCallState();
      const lookup = vi.fn(async () =>
        candidateSearchResult(
          ...(status === "not_found"
            ? []
            : [receipt(), receipt("Jane Meyer", "01/01/1980", "two")]),
        ),
      );
      for (let i = 0; i < 3; i++)
        expect(
          (await resolveExistingPatient(state, fullIdentity, lookup)).outcome,
        ).toBe(status);
      expect(lookup).toHaveBeenCalledOnce();
      state.office.phoneOverrides[state.office.activeKey] = "+19545550199";
      await resolveExistingPatient(state, fullIdentity, lookup);
      expect(lookup).toHaveBeenCalledTimes(2);
    },
  );

  it("reuses a definitive decision after unrelated chart and office data changes", async () => {
    const state = createConfirmedPatientState();
    const lookup = vi.fn(async () => candidateSearchResult());
    const identity = { ...fullIdentity, firstName: "Absent" };
    expect(
      (await resolveExistingPatient(state, identity, lookup)).outcome,
    ).toBe("not_found");
    state.identity.activePatient!.appointments.push({
      id: 42,
      date: "01/01/2027",
      time: "09:00",
      provider: "Synthetic",
      type: "Office",
      facility: "Synthetic",
      confirmed: false,
    });
    state.identity.activePatient!.appointmentsStatus = "found";
    state.identity.activePatient!.backend.insPlanId = "changed-plan";
    state.office.phoneOverrides["hollywood"] = "+19545550199";
    expect(
      (await resolveExistingPatient(state, identity, lookup)).outcome,
    ).toBe("not_found");
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("recomputes an ambiguous decision when candidate identity changes", async () => {
    const state = createTestCallState({
      preCallCandidates: [candidate(), candidate("two")],
    });
    const lookup = vi.fn();
    expect(
      (
        await resolveExistingPatient(
          state,
          { firstName: "Jane", dob: fullIdentity.dob },
          lookup,
        )
      ).outcome,
    ).toBe("multiple_matches");
    state.identity.privateCandidates[1]!.dob = "02/02/1982";
    expect(
      (
        await resolveExistingPatient(
          state,
          { firstName: "Jane", dob: fullIdentity.dob },
          lookup,
        )
      ).outcome,
    ).toBe("verified");
    expect(state.identity.activePatient?.patientId).toBe("one");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refreshes an active chart when appointment loading changes to error after a cached decision", async () => {
    const state = createConfirmedPatientState({
      preCallCandidates: [candidate("patient-1", "Doe")],
    });
    const lookup = vi.fn(async () =>
      receipt("Jane Doe", fullIdentity.dob, "patient-1"),
    );
    expect(
      (await resolveExistingPatient(state, { firstName: "Jane" }, lookup))
        .outcome,
    ).toBe("verified");
    expect(lookup).not.toHaveBeenCalled();
    state.identity.activePatient!.appointmentsStatus = "error";
    expect(
      (await resolveExistingPatient(state, { firstName: "Jane" }, lookup))
        .outcome,
    ).toBe("verified");
    expect(lookup).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      patientId: "patient-1",
    });
  });

  it.each([
    [503, 503],
    [200, 503],
    [503, 200],
    [200, 200],
  ])(
    "bounds mixed backend failures %j / %j to two HTTP requests",
    async (first, second) => {
      const state = createTestCallState();
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: "error" }), { status: first }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: "error" }), { status: second }),
        );
      const client = new HttpOwnedMiddleware({
        fetch,
        authToken: "synthetic",
        middlewareBaseUrl: "https://middleware.test",
      });
      const lookup = vi.fn((office, identity) =>
        client.resolvePatient({ office, identity }),
      );
      for (let i = 0; i < 3; i++) {
        const result = await resolveExistingPatient(
          state,
          fullIdentity,
          lookup,
        );
        expect(result.outcome).toBe("lookup_failed");
        expect(result.reply).toContain("staff");
      }
      expect(lookup).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(state.identity.unregisteredPatientReceipt).toBeNull();
    },
  );

  it("recovers a transient backend failure within one resolver invocation", async () => {
    const state = createTestCallState();
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("synthetic network failure"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(candidateSearchResult(receipt()))),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt())));
    const client = new HttpOwnedMiddleware({
      fetch,
      authToken: "synthetic",
      middlewareBaseUrl: "https://middleware.test",
    });
    expect(
      (
        await resolveExistingPatient(state, fullIdentity, (office, identity) =>
          client.resolvePatient({ office, identity }),
        )
      ).outcome,
    ).toBe("verified");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("cannot reactivate the previous chart for a caller-declared different person with the same first name", async () => {
    const state = createTestCallState({ preCallCandidates: [candidate()] });
    const lookup = vi.fn();
    await resolveExistingPatient(state, { firstName: "Jane" }, lookup);
    state.availability.bookingTokensBySlotId = { old: "synthetic" };
    const switching = await resolveExistingPatient(
      state,
      { firstName: "Jane", patientContext: "different_patient" },
      lookup,
    );
    expect(switching.outcome).toBe("needs_identity");
    expect(switching.reply).toContain("date of birth");
    expect(state.identity.activePatient).toBeNull();
    expect(state.availability.bookingTokensBySlotId).toEqual({});
    expect(
      (
        await resolveExistingPatient(
          state,
          { dob: "01/01/1980", lastName: "Meyer" },
          lookup,
        )
      ).outcome,
    ).toBe("multiple_matches");
    expect(state.identity.activePatient).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("looks up an explicitly different person whose complete identity conflicts with phone candidates", async () => {
    const state = createTestCallState({ preCallCandidates: [candidate()] });
    await resolveExistingPatient(state, { firstName: "Jane" }, vi.fn());
    const lookup = vi
      .fn()
      .mockResolvedValueOnce(
        candidateSearchResult(receipt("Jane Meyer", "01/01/2000", "two")),
      )
      .mockResolvedValueOnce(receipt("Jane Meyer", "01/01/2000", "two"));
    expect(
      (
        await resolveExistingPatient(
          state,
          {
            ...fullIdentity,
            dob: "01/01/2000",
            patientContext: "different_patient",
          },
          lookup,
        )
      ).outcome,
    ).toBe("verified");
    expect(state.identity.activePatient?.patientId).toBe("two");
    expect(lookup).toHaveBeenNthCalledWith(1, expect.any(String), {
      firstName: "Jane",
      dob: "01/01/2000",
    });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("keeps repeated unchanged switch requests idempotent while unresolved", async () => {
    const state = createTestCallState();
    const lookup = vi.fn(async () => candidateSearchResult());
    for (let i = 0; i < 3; i++)
      await resolveExistingPatient(
        state,
        { ...fullIdentity, patientContext: "different_patient" },
        lookup,
      );
    expect(lookup).toHaveBeenCalledOnce();
  });

  it.each([
    receipt("John Meyer"),
    receipt("Jane Meyer", "02/02/1980"),
    receipt("Jane Meyer", "01/01/1980", "other"),
  ])("rejects mismatched hydration receipt %#", async (result) => {
    const state = createTestCallState({
      preCallCandidates: [{ ...candidate(), status: "candidate" }],
    });
    const lookup = vi.fn(async () => result);
    expect(
      (await resolveExistingPatient(state, fullIdentity, lookup)).outcome,
    ).toBe("lookup_failed");
    expect(state.identity.activePatient).toBeNull();
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("clears pending evidence for an explicit same-first-name patient switch", async () => {
    const state = createTestCallState();
    const lookup = vi.fn(async () => candidateSearchResult());
    await resolveExistingPatient(state, fullIdentity, lookup);
    const result = await resolveExistingPatient(
      state,
      { firstName: "Jane", patientContext: "different_patient" },
      lookup,
    );
    expect(result.outcome).toBe("needs_identity");
    expect(result.reply).toContain("date of birth");
    expect(state.identity.unregisteredPatientReceipt).toBeNull();
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("keeps other fields only for an explicit first-name correction", async () => {
    const state = createTestCallState();
    const lookup = vi.fn(async () => candidateSearchResult());
    await resolveExistingPatient(
      state,
      { ...fullIdentity, firstName: "Jame" },
      lookup,
    );
    await resolveExistingPatient(
      state,
      { firstName: "Jane", patientContext: "correction" },
      lookup,
    );
    expect(lookup).toHaveBeenLastCalledWith(expect.any(String), {
      firstName: fullIdentity.firstName,
      dob: fullIdentity.dob,
    });
    await resolveExistingPatient(state, { firstName: "John" }, lookup);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(state.identity.unregisteredPatientReceipt).toBeNull();
  });

  it("invalidates pending hydration when a later partial identity changes the person", async () => {
    const state = createTestCallState({
      preCallCandidates: [{ ...candidate(), status: "candidate" }],
    });
    let complete!: (value: ReturnType<typeof receipt>) => void;
    const pending = resolveExistingPatient(
      state,
      fullIdentity,
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await resolveExistingPatient(
      state,
      { firstName: "John", patientContext: "different_patient" },
      vi.fn(),
    );
    complete(receipt());
    expect((await pending).outcome).toBe("superseded");
    expect(state.identity.activePatient).toBeNull();
  });

  it("does not reuse pending evidence after new-patient registration starts", async () => {
    const state = createTestCallState();
    const lookup = vi.fn(async () => candidateSearchResult());
    await resolveExistingPatient(state, fullIdentity, lookup);
    beginNewPatientRegistration(state, {
      firstName: "New",
      lastName: "Patient",
      dob: "03/03/1990",
    });
    expect(
      (await resolveExistingPatient(state, { firstName: "Jane" }, lookup))
        .outcome,
    ).toBe("needs_identity");
    expect(lookup).toHaveBeenCalledOnce();
  });
});
