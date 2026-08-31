import { describe, expect, it, vi } from "vitest";
import { HttpOwnedMiddleware } from "../clients/owned-middleware.js";
import { SPRING_HILL_OFFICE_PHONE } from "../customers/abita/profile.js";
import { createCheckInsuranceTool } from "../tools/check-insurance.js";
import { createTestCallState } from "./support/call-state.js";
import { InMemoryOwnedMiddleware } from "./support/owned-middleware.js";

function insuranceResult(
  plan: string,
  status: "accepted" | "not_accepted",
  callerNotice: string | null,
) {
  return {
    status,
    query: plan,
    matchedPlan: plan,
    matchedAlias: null,
    matchedFamily: null,
    callerFacingPlan: plan,
    canProceed: status === "accepted",
    needsExactPlanName: false,
    clarificationNeeded: null,
    callerNotice,
    preauthRequired: false,
    authoritative: true,
  } as const;
}

function toolContext(state: ReturnType<typeof createTestCallState>) {
  return {
    disallowInterruptions: vi.fn(),
    session: { userData: state },
  };
}

describe("middleware-backed insurance checks", () => {
  it("presents the authoritative Spring Hill Humana decisions", async () => {
    const middleware = new InMemoryOwnedMiddleware({
      checkInsurance: [
        insuranceResult("Humana Gold", "not_accepted", null),
        insuranceResult(
          "Humana Medicare",
          "accepted",
          "At Spring Hill, patients with this plan can see any provider.",
        ),
        insuranceResult(
          "Humana Medicaid",
          "accepted",
          "At Spring Hill, patients with this plan can only see Dr. Bach.",
        ),
      ],
    });
    const checkInsurance = createCheckInsuranceTool(middleware);
    const state = createTestCallState();
    const ctx = toolContext(state);

    const responses: string[] = [];
    for (const plan of ["Humana Gold", "Humana Medicare", "Humana Medicaid"]) {
      responses.push(
        await checkInsurance.execute({ plan, coverageType: "medical" }, {
          ctx: ctx as never,
          toolCallId: `check-${plan}`,
        } as never),
      );
    }

    expect(responses).toEqual([
      "No, we don't accept Humana Gold.",
      "Yes, we take Humana Medicare. At Spring Hill, patients with this plan can see any provider.",
      "Yes, we take Humana Medicaid. At Spring Hill, patients with this plan can only see Dr. Bach.",
    ]);
    expect(middleware.requests.checkInsurance).toEqual([
      {
        office: SPRING_HILL_OFFICE_PHONE,
        plan: "Humana Gold",
        coverageType: "medical",
      },
      {
        office: SPRING_HILL_OFFICE_PHONE,
        plan: "Humana Medicare",
        coverageType: "medical",
      },
      {
        office: SPRING_HILL_OFFICE_PHONE,
        plan: "Humana Medicaid",
        coverageType: "medical",
      },
    ]);
    expect(state.insurance.lastEligibilityCheck).toMatchObject({
      canonicalPlan: "Humana Medicaid",
      accepted: true,
    });
  });

  it("lets middleware classify unrelated checks before using the office reference", async () => {
    const middleware = new InMemoryOwnedMiddleware();
    const checkInsurance = createCheckInsuranceTool(middleware);
    const state = createTestCallState();

    const response = await checkInsurance.execute(
      { plan: "Aetna", coverageType: "medical" },
      {
        ctx: toolContext(state) as never,
        toolCallId: "check-unrelated-plan",
      } as never,
    );

    expect(response).toBe("Yes, we take Aetna.");
    expect(middleware.requests.checkInsurance).toEqual([
      {
        office: SPRING_HILL_OFFICE_PHONE,
        plan: "Aetna",
        coverageType: "medical",
      },
    ]);
  });

  it("normalizes the authenticated middleware response", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        insuranceResult(
          "Humana Medicaid",
          "accepted",
          "At Spring Hill, patients with this plan can only see Dr. Bach.",
        ),
      ),
    );
    const middleware = new HttpOwnedMiddleware({
      authToken: "test-secret",
      fetch: fetchMock as typeof fetch,
      middlewareBaseUrl: "https://middleware.example",
    });

    const result = await middleware.checkInsurance({
      office: SPRING_HILL_OFFICE_PHONE,
      plan: "Humana Medicaid",
      coverageType: "medical",
    });

    expect(result).toMatchObject({
      status: "accepted",
      matchedPlan: "Humana Medicaid",
      canProceed: true,
      callerNotice:
        "At Spring Hill, patients with this plan can only see Dr. Bach.",
      authoritative: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://middleware.example/api/insurance/check",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "test-secret",
        }),
      }),
    );
  });
});
