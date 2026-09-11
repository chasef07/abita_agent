import { isToolset } from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";
import {
  triage_eye_care,
  notify_after_hours_physician,
  NEW_TAMPA_DEMO_AFTER_HOURS_CONTACT,
  newTampaSchedulingBlock,
  newTampaProviderAllowed,
  createNewTampaDemoTools,
} from "../customers/abita/new-tampa-demo.js";
import {
  NEW_TAMPA_DEMO_TRUNK_PHONE,
  OPHTHALMOLOGY_DEMO_TRUNK_PHONE,
  DEMO_BOOKING_OFFICE_PHONE,
  getOfficeProfileByPhone,
} from "../customers/abita/profile.js";
import { buildPrompt } from "../prompt.js";
import { matchInsurancePlanForOffice } from "../insurance-rules.js";
import { buildToolsForTrunk } from "../runtime/tool-registry.js";
import { availabilitySlotsForState } from "../scheduling/availability.js";
import { createConfirmedPatientState } from "./support/call-state.js";
import { createToolContext } from "./support/tool-context.js";
import { InMemorySchedulingMiddleware } from "./support/scheduling-middleware.js";
import { InMemoryOwnedMiddleware } from "./support/owned-middleware.js";
import type { AvailabilityResult } from "../clients/owned-middleware.js";

function stateForDemo() {
  const state = createConfirmedPatientState({
    officeKey: "new-tampa-demo",
    trunkPhone: NEW_TAMPA_DEMO_TRUNK_PHONE,
    amdOfficePhone: DEMO_BOOKING_OFFICE_PHONE,
  });
  state.workflow.visitType = "medical";
  return state;
}
const context = (state: ReturnType<typeof stateForDemo>) =>
  ({ ctx: createToolContext(state), toolCallId: "demo-test" }) as never;
const clock = { now: () => new Date("2026-09-07T12:00:00Z") };
function openings(providers: string[]): AvailabilityResult {
  return {
    status: "found",
    requestedDate: "2026-09-07",
    actualDate: "2026-12-07",
    searchedFrom: "2026-09-07",
    searchedThrough: "2026-12-07",
    slots: providers.map((provider, index) => ({
      provider,
      datetime: "2026-12-07T14:00:00-05:00",
      date: "2026-12-07",
      time: "2:00 PM",
      key: `provider-${index}`,
    })),
  };
}

describe("New Tampa 320 demo", () => {
  it("personalizes the 320 line while preserving the Product office and demo account", () => {
    const office = getOfficeProfileByPhone(NEW_TAMPA_DEMO_TRUNK_PHONE);
    expect(office).toMatchObject({
      displayName: "New Tampa Eye Institute",
      key: "new-tampa-demo",
      amdOfficePhone: DEMO_BOOKING_OFFICE_PHONE,
    });
    const prompt = buildPrompt(NEW_TAMPA_DEMO_TRUNK_PHONE);
    expect(prompt).toContain("New Tampa Eye Institute");
    expect(office.greeting).toContain("New Tampa Eye Institute demo");
    expect(prompt).not.toMatch(/Willowmere|Clearbrook|988/);
    expect(
      getOfficeProfileByPhone(OPHTHALMOLOGY_DEMO_TRUNK_PHONE).displayName,
    ).toBe("Clearbrook Eye Center");
  });

  it("explains routine exam versus Doctor Scott Friedman, then requires agreement to Doctor Smur", async () => {
    const state = stateForDemo();
    const result = await triage_eye_care.execute(
      { purpose: "routine_vision", requestedProvider: "Dr Scott Friedman" },
      context(state),
    );
    expect(result).toContain(
      "Sorry, Doctor Scott Friedman specializes in retina care.",
    );
    expect(result).toContain("specializes in retina care");
    expect(result).toContain(
      "Doctor Bradley Smur handles glasses prescriptions and routine eye exams, and I can help you book with him.",
    );
    expect(result).toContain("Ask whether to check Doctor Smur's openings");
    const middleware = new InMemorySchedulingMiddleware();
    expect(
      await createNewTampaDemoTools(
        middleware,
        clock,
      ).list_available_appointments.execute(
        { visitType: "routine_vision" },
        context(state),
      ),
    ).toBe(result);
    expect(middleware.operations).toEqual([]);
    await triage_eye_care.execute(
      { purpose: "routine_vision", requestedProvider: "Doctor Bradley Smurr" },
      context(state),
    );
    expect(newTampaSchedulingBlock(state, "routine_vision")).toBeNull();
    expect(newTampaSchedulingBlock(state, "medical")).toContain(
      "visit type changed",
    );
  });

  it.each(["Dr Friedman", "Dr Fridman", "Dr Freidman"])(
    "redirects a glasses request for %s without unnecessary first-name clarification",
    async (requestedProvider) => {
      const state = stateForDemo();
      const result = await triage_eye_care.execute(
        { purpose: "routine_vision", requestedProvider },
        context(state),
      );
      expect(result).toContain(
        "Doctor Bradley Smur, our optometrist, is the right provider",
      );
      expect(result).toContain("I can help you book with him");
      expect(result).not.toContain("Clarify the provider's full name");
      expect(newTampaSchedulingBlock(state)).toBe(result);
    },
  );

  it.each(["Dr Friedman", "Dr Fridman", "Dr Freidman", "Doctor Unknown"])(
    "clarifies an ambiguous or unknown provider: %s",
    async (requestedProvider) => {
      const state = stateForDemo();
      expect(
        await triage_eye_care.execute(
          { purpose: "glaucoma", requestedProvider },
          context(state),
        ),
      ).toContain("Clarify the provider's full name");
      expect(newTampaSchedulingBlock(state)).not.toBeNull();
    },
  );

  it.each([
    ["routine_vision", ["smur"]],
    ["cataract", ["gretta"]],
    ["glaucoma", ["gretta", "khan"]],
    ["retina", ["scott"]],
    ["eyelid", ["small"]],
  ] as const)(
    "routes %s using the caller's purpose",
    async (purpose, expected) => {
      const state = stateForDemo();
      await triage_eye_care.execute(
        { purpose, requestedProvider: null },
        context(state),
      );
      const names = {
        gretta: "Gretta Fridman",
        khan: "Hirah Khan",
        scott: "Scott Friedman",
        small: "Laurie Small",
        smur: "Bradley Smur",
      };
      for (const [id, name] of Object.entries(names)) {
        expect(newTampaProviderAllowed(state, name)).toBe(
          expected.includes(id as never),
        );
      }
    },
  );

  it("filters mismatched and unrelated demo providers before offering slots", async () => {
    const state = stateForDemo();
    await triage_eye_care.execute(
      { purpose: "retina", requestedProvider: "Scott Friedman" },
      context(state),
    );
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        openings([
          "Doctor Gretta Fridman",
          "Scott Friedman MD",
          "Unrelated Demo Provider",
        ]),
      ],
    });
    const result = await createNewTampaDemoTools(
      middleware,
      clock,
    ).list_available_appointments.execute(
      { visitType: "medical", startDate: "2026-11-02" },
      context(state),
    );
    expect(result).toContain("Scott Friedman");
    expect(result).not.toMatch(/Gretta|Unrelated/);
    expect(availabilitySlotsForState(state)).toHaveLength(1);
    expect(middleware.operations).toMatchObject([
      { kind: "availability", office: DEMO_BOOKING_OFFICE_PHONE },
    ]);
  });

  it("offers staff when the shared calendar has no matching provider", async () => {
    const state = stateForDemo();
    await triage_eye_care.execute(
      { purpose: "retina", requestedProvider: null },
      context(state),
    );
    const middleware = new InMemorySchedulingMiddleware({
      availability: [openings(["Unrelated Demo Provider"])],
    });
    expect(
      await createNewTampaDemoTools(
        middleware,
        clock,
      ).list_available_appointments.execute(
        { visitType: "medical" },
        context(state),
      ),
    ).toContain("Offer transfer_call");
    expect(availabilitySlotsForState(state)).toEqual([]);
  });

  it("stops booking a distant slot when the caller reports urgency", async () => {
    const state = stateForDemo();
    await triage_eye_care.execute(
      { purpose: "retina", requestedProvider: null },
      context(state),
    );
    const middleware = new InMemorySchedulingMiddleware({
      availability: [openings(["Scott Friedman"])],
    });
    const demoTools = createNewTampaDemoTools(middleware, clock);
    await demoTools.list_available_appointments.execute(
      { visitType: "medical", startDate: "2026-11-02" },
      context(state),
    );
    const ref = availabilitySlotsForState(state)[0]!.slotId;
    const urgent = await triage_eye_care.execute(
      { purpose: "urgent", requestedProvider: null },
      context(state),
    );
    expect(urgent).toContain("Call transfer_call now");
    expect(
      await demoTools.book_appointment.execute(
        {
          appointmentSlotRef: ref,
          appointmentReason: "urgent vision problem",
          referringDoctor: "none",
          readBack: true,
        },
        context(state),
      ),
    ).toContain("Stop scheduling");
    expect(middleware.operations.map((op) => op.kind)).toEqual([
      "availability",
    ]);
  });

  it("discards in-flight availability when the caller changes triage", async () => {
    const state = stateForDemo();
    await triage_eye_care.execute(
      { purpose: "retina", requestedProvider: null },
      context(state),
    );
    let finish!: (result: AvailabilityResult) => void;
    const pendingResult = new Promise<AvailabilityResult>((resolve) => {
      finish = resolve;
    });
    const middleware = new InMemorySchedulingMiddleware({
      availability: [pendingResult],
    });
    const pending = createNewTampaDemoTools(
      middleware,
      clock,
    ).list_available_appointments.execute(
      { visitType: "medical" },
      context(state),
    );
    await triage_eye_care.execute(
      { purpose: "urgent", requestedProvider: null },
      context(state),
    );
    finish(openings(["Scott Friedman"]));
    expect(await pending).toContain("changed while I was checking");
    expect(availabilitySlotsForState(state)).toEqual([]);
  });

  it("keeps triage isolated between calls", async () => {
    const first = stateForDemo();
    const second = stateForDemo();
    await triage_eye_care.execute(
      { purpose: "retina", requestedProvider: null },
      context(first),
    );
    expect(newTampaSchedulingBlock(first)).toBeNull();
    expect(newTampaSchedulingBlock(second)).toContain("Call triage_eye_care");
    expect(first).not.toHaveProperty("newTampaTriage");
  });

  it("invalidates triage when the active patient changes", async () => {
    const state = stateForDemo();
    await triage_eye_care.execute(
      { purpose: "retina", requestedProvider: null },
      context(state),
    );
    state.identity.transitionVersion += 1;
    expect(newTampaSchedulingBlock(state)).toContain("current patient");
  });

  it("simulates an after-hours alert without network delivery and blocks routine scheduling", async () => {
    const state = stateForDemo();
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      const result = await notify_after_hours_physician.execute(
        { afterHoursUrgent: true },
        context(state),
      );
      expect(result).toContain(
        "No real SMS was sent and no physician was contacted",
      );
      const script = result.match(/say: "([^"]+)"/)?.[1];
      expect(script).toBe(
        `We'll send a text to the on-call physician now. You can also call or reach out at ${NEW_TAMPA_DEMO_AFTER_HOURS_CONTACT}.`,
      );
      expect(script).not.toMatch(/demo|simulat/i);
      expect(result).toContain(
        "rehearsal number, not a verified physician line",
      );
      expect(result).toContain(
        "If asked whether a real message was sent, answer no.",
      );
      expect(result).toContain("Call transfer_call");
      expect(newTampaSchedulingBlock(state)).toContain(
        "After-hours urgent concern",
      );
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it("exposes demo-specific tools only on the 320 line", () => {
    const names = (phone: string) =>
      buildToolsForTrunk(new InMemoryOwnedMiddleware(), phone)
        .flatMap((entry) => (isToolset(entry) ? entry.tools : [entry]))
        .map((entry) => entry.id);
    expect(names(NEW_TAMPA_DEMO_TRUNK_PHONE)).toEqual(
      expect.arrayContaining([
        "triage_eye_care",
        "notify_after_hours_physician",
      ]),
    );
    expect(names(OPHTHALMOLOGY_DEMO_TRUNK_PHONE)).not.toEqual(
      expect.arrayContaining(["triage_eye_care"]),
    );
  });

  it.each([
    ["Ambetter Premier", "medical", "accepted"],
    ["VSP", "routine_vision", "accepted"],
    ["Humana Gold", "medical", "not_accepted"],
    ["CarePlus Medicare Vision", "routine_vision", "needs_staff_task"],
    ["Example Health Gold 9000", "medical", "needs_clarification"],
  ] as const)(
    "labels the %s insurance result as demo-only",
    async (plan, coverageType, status) => {
      expect(
        matchInsurancePlanForOffice("new-tampa-demo", plan, coverageType)
          .status,
      ).toBe(status);
      const result = await createNewTampaDemoTools(
        new InMemorySchedulingMiddleware(),
      ).check_insurance.execute(
        { plan, coverageType },
        context(stateForDemo()),
      );
      expect(result).toMatch(/^For this demo only:/);
      expect(result).toContain(
        "Actual New Tampa insurance participation and requirements are unverified.",
      );
    },
  );

  it("uses separate medical and vision demo insurance and leaves unknown plans unresolved", () => {
    expect(
      matchInsurancePlanForOffice(
        "new-tampa-demo",
        "Ambetter Premier",
        "medical",
      ),
    ).toMatchObject({
      status: "accepted",
      callerNotice: expect.stringContaining("demo insurance match"),
    });
    expect(
      matchInsurancePlanForOffice("new-tampa-demo", "VSP", "routine_vision"),
    ).toMatchObject({
      status: "accepted",
      callerNotice: expect.stringContaining("demo insurance match"),
    });
    expect(
      matchInsurancePlanForOffice(
        "new-tampa-demo",
        "Example Health Gold 9000",
        "medical",
      ),
    ).toMatchObject({ status: "needs_clarification" });
    expect(
      matchInsurancePlanForOffice("new-tampa-demo", "Humana Gold", "medical"),
    ).toMatchObject({ status: "not_accepted" });
  });
});
