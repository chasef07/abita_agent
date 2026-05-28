// agent.ts — Agent definition
// Instructions loaded from workspace/ files, tools wired below.

import { llm, stt, voice } from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import type { ReadableStream } from "node:stream/web";
import { buildPrompt } from "./prompt.js";
import {
  reconcileCallStateAfterActivePatientChange,
  type CallState,
  type PhoneLookupResult,
} from "./tooling/call-state.js";
import type { VoiceLanguageRuntime } from "./language-runtime.js";
import {
  advanceWorkflow,
  compileTurnStatePacket,
  inferObviousTurnUnderstanding,
  nextFlowEventId,
  reduceFlowEvent,
} from "./flow/index.js";
import { getOfficeConfigByPhone } from "./customer/profile.js";
import {
  buildToolsForTrunk as buildToolsForTrunkFromRegistry,
  refreshAgentToolsForSession,
  type AgentTools,
} from "./tooling/tool-registry.js";

export function buildToolsForTrunk(trunkPhone?: string): AgentTools {
  return buildToolsForTrunkFromRegistry(trunkPhone);
}

export class Agent extends voice.Agent {
  private greeting: string;
  private languageRuntime?: VoiceLanguageRuntime;

  constructor(
    phoneLookup?: PhoneLookupResult,
    trunkPhone?: string,
    options: {
      languageRuntime?: VoiceLanguageRuntime;
      suppressGreeting?: boolean;
    } = {},
  ) {
    const office = getOfficeConfigByPhone(trunkPhone ?? "");
    super({
      instructions: buildPrompt(phoneLookup, trunkPhone),
      tools: buildToolsForTrunk(trunkPhone),
    });
    this.greeting = office.greeting;
    this.languageRuntime = options.languageRuntime;
    if (options.suppressGreeting) this.greeting = "";
  }

  override async onEnter(): Promise<void> {
    if (!this.greeting) return;
    // Brief delay so the SIP audio path is fully established before speaking
    await new Promise((r) => setTimeout(r, 500));
    await this.session.say(this.greeting);
  }

  override async onUserTurnCompleted(
    chatCtx: llm.ChatContext,
    newMessage: llm.ChatMessage,
  ): Promise<void> {
    const state = this.session.userData as CallState | undefined;
    const transcript = newMessage.textContent ?? "";
    if (!state?.flowHarnessEnabled || !state.flow || !transcript) return;

    state.latestUserTranscript = transcript;
    state.turnUnderstandingAppliedForTranscript = null;
    const activePatientRefBefore = state.flow.activePatientRef;
    const preCallIdentity = reduceFlowEvent(state.flow, {
      id: nextFlowEventId("pre_call_identity"),
      type: "pre_call_identity_observed",
      source: "deterministic_understanding",
      createdAt: Date.now(),
      transcript,
    }).preCallIdentity;
    if (
      preCallIdentity?.changed &&
      state.flow.activePatientRef &&
      state.flow.activePatientRef !== activePatientRefBefore
    ) {
      reconcileCallStateAfterActivePatientChange(state, "patient_changed");
    }
    const inferred = inferObviousTurnUnderstanding(state.flow, transcript);
    const automaticTurnUpdateApplied = Boolean(
      inferred || preCallIdentity?.changed,
    );
    if (inferred) {
      const turn = advanceWorkflow(state.flow, {
        type: "caller_intent_recorded",
        transcript,
        understanding: inferred,
        source: "deterministic_understanding",
      });
      state.turnUnderstandingAppliedForTranscript = transcript;
      if (turn.update) {
        state.lastTurnUnderstanding = {
          goal: turn.update.understanding.goal,
          appointmentAction: turn.update.understanding.appointmentAction,
          confidence: turn.update.understanding.confidence,
          activeIntent: state.flow.activeIntent,
          activePatientRef: state.flow.activePatientRef,
        };
      }
    } else if (preCallIdentity?.changed) {
      advanceWorkflow(state.flow, { type: "facts_changed" });
      state.turnUnderstandingAppliedForTranscript = transcript;
    }
    await refreshAgentToolsForSession(
      this.session,
      automaticTurnUpdateApplied
        ? "turn_update_auto_recorded"
        : "turn_update_pending",
    );
    chatCtx.addMessage({
      role: "system",
      content: [
        compileTurnStatePacket(state.flow),
        "",
        "<workflow_guidance>",
        automaticTurnUpdateApplied
          ? "The reducer already recorded deterministic state for this turn. Use the current turn_state as guidance, and call the suggested read-only tool when prerequisites are met. Side effects still require explicit confirmation and policy approval."
          : "No automatic intent update was applied. Use the current turn_state, caller wording, and concrete tool facts to either ask one clarifying question or call a safe workflow tool. Side effects still require explicit confirmation and policy approval.",
        "</workflow_guidance>",
      ].join("\n"),
      id: `flow_turn_state_${newMessage.id}`,
      createdAt: newMessage.createdAt + 1,
    });
  }

  override async sttNode(
    audio: ReadableStream<AudioFrame>,
    modelSettings: voice.ModelSettings,
  ): Promise<ReadableStream<stt.SpeechEvent | string> | null> {
    const events = await voice.Agent.default.sttNode(
      this,
      audio,
      modelSettings,
    );
    if (!events || !this.languageRuntime) return events;

    return this.languageRuntime.observeSpeechEvents(events);
  }
}
