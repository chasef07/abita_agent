import type {
  CallPortal,
  CallPortalDelivery,
  CallPortalPhase,
  CallPortalResult,
} from "../../runtime/call-closeout.js";

export class InMemoryCallPortal implements CallPortal {
  readonly deliveries: CallPortalDelivery[] = [];
  readonly waits: number[] = [];
  private readonly results: Partial<
    Record<CallPortalPhase, CallPortalResult[]>
  >;

  constructor(
    results: Partial<Record<CallPortalPhase, CallPortalResult[]>> = {},
  ) {
    this.results = Object.fromEntries(
      Object.entries(results).map(([phase, phaseResults]) => [
        phase,
        [...phaseResults],
      ]),
    );
  }

  async deliver(delivery: CallPortalDelivery): Promise<CallPortalResult> {
    this.deliveries.push(delivery);
    return this.results[delivery.phase]?.shift() ?? { ok: true, status: 200 };
  }

  async wait(ms: number): Promise<void> {
    this.waits.push(ms);
  }
}
