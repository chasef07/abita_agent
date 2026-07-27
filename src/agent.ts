// agent.ts — Agent definition
// Instructions loaded from workspace files, tools wired below.

import {
  Agent as LiveKitAgent,
  ChatContext,
  ChatMessage,
  type ModelSettings,
  type stt,
} from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import type { ReadableStream } from "node:stream/web";
import { buildPrompt } from "./prompt.js";
import { resolvePatientWithOwnedMiddleware } from "./clients/owned-middleware.js";
import type { CallState } from "./state/call-state.js";
import { recordLatestUserTranscript } from "./state/call-lifecycle.js";
import {
  observeSttLanguage,
  type SttLanguageDecision,
  type SttLanguageDetector,
} from "./stt-language-detector.js";
import { getOfficeProfileByPhone } from "./customers/abita/profile.js";
import { confirmPreCallIdentityFromTranscript } from "./runtime/precall-transcript-confirmation.js";
import { buildToolsForTrunk } from "./runtime/tool-registry.js";
import {
  confirmedPatientModelContext,
  type PatientResolveLookup,
} from "./identity/promotion.js";
import { officeKnowledgeContext } from "./office-knowledge.js";
import { activeOfficeKey } from "./state/call-lifecycle.js";
import { recordOfficeKnowledgeContext } from "./state/observability.js";
import {
  createInitialLookupChatContext,
  type ModelFacingLookupStatus,
} from "./runtime/precall-model-context.js";
import {
  clinicTimestampMessage,
  systemSchedulingClock,
  type SchedulingClock,
} from "./scheduling/availability-when.js";

type VoiceAgentOptions = {
  identityLookup?: PatientResolveLookup;
  onAssistantText?: (text: string, complete: boolean) => void;
  onLanguageDecision?: (decision: SttLanguageDecision) => void;
  suppressGreeting?: boolean;
  sttLanguageDetector?: SttLanguageDetector;
  turnClock?: SchedulingClock;
};

const PATIENT_CONTEXT_MESSAGE_ID_PREFIX = "call_state_patient_context:";
const OFFICE_KNOWLEDGE_MESSAGE_ID_PREFIX = "office_knowledge_context:";

export function createVoiceAgent(
  lookupStatus: ModelFacingLookupStatus,
  trunkPhone: string,
  options: VoiceAgentOptions = {},
) {
  const office = getOfficeProfileByPhone(trunkPhone);
  const greeting = options.suppressGreeting ? "" : office.greeting;
  const identityLookup: PatientResolveLookup =
    options.identityLookup ?? resolvePatientWithOwnedMiddleware;
  const initialChatContext = createInitialLookupChatContext(lookupStatus);
  setOfficeKnowledgeModelContext(initialChatContext, office.key);

  const agent = LiveKitAgent.create<CallState>({
    instructions: buildPrompt(trunkPhone),
    chatCtx: initialChatContext,
    tools: buildToolsForTrunk(trunkPhone, {
      identityLookup,
    }),

    async onEnter(ctx): Promise<void> {
      if (!greeting) return;
      // Brief delay so the SIP audio path is fully established before speaking
      await new Promise((r) => setTimeout(r, 500));
      await ctx.session.say(greeting);
    },

    async onUserTurnCompleted(
      ctx,
      chatCtx: ChatContext,
      newMessage: ChatMessage,
    ): Promise<void> {
      chatCtx.addMessage({
        role: "system",
        content: clinicTimestampMessage(
          (options.turnClock ?? systemSchedulingClock).now(),
        ),
      });

      const state = ctx.session.userData;
      const transcript = newMessage.textContent ?? "";
      if (!transcript) return;

      recordLatestUserTranscript(state, transcript);
      const confirmation = await confirmPreCallIdentityFromTranscript(
        {
          state,
          transcript,
        },
        identityLookup,
      );
      const patientContext =
        confirmation?.systemMessage ?? confirmedPatientModelContext(state);
      setPatientModelContext(chatCtx, state, patientContext);

      const officeKey = activeOfficeKey(state);
      setOfficeKnowledgeModelContext(chatCtx, officeKey);
    },

    async llmNode(ctx, chatCtx, toolCtx, modelSettings) {
      refreshPatientModelContext(chatCtx, ctx.session.userData);
      const officeKey = activeOfficeKey(ctx.session.userData);
      const activeKnowledge = setOfficeKnowledgeModelContext(
        chatCtx,
        officeKey,
      );
      recordOfficeKnowledgeContext(ctx.session.userData, {
        documentHash: activeKnowledge.documentHash,
        officeKey,
        schemaVersion: activeKnowledge.schemaVersion,
      });
      return LiveKitAgent.default.llmNode(
        ctx.agent,
        chatCtx,
        toolCtx as unknown as Parameters<
          typeof LiveKitAgent.default.llmNode
        >[2],
        modelSettings,
      );
    },

    async sttNode(
      ctx,
      audio: ReadableStream<AudioFrame> | AsyncIterable<AudioFrame>,
      modelSettings: ModelSettings,
    ): Promise<ReadableStream<stt.SpeechEvent | string> | null> {
      const events = await LiveKitAgent.default.sttNode(
        ctx.agent,
        audio,
        modelSettings,
      );
      if (!events || !options.sttLanguageDetector) return events;

      return observeSttLanguage(
        events,
        options.sttLanguageDetector,
        options.onLanguageDecision,
      );
    },

    async ttsNode(ctx, text, modelSettings) {
      return LiveKitAgent.default.ttsNode(
        ctx.agent,
        options.onAssistantText
          ? observeAssistantText(text, options.onAssistantText)
          : text,
        modelSettings,
      );
    },
  });

  return { agent, office };
}

function setOfficeKnowledgeModelContext(
  chatCtx: ChatContext,
  officeKey: Parameters<typeof officeKnowledgeContext>[0],
): ReturnType<typeof officeKnowledgeContext> {
  const context = officeKnowledgeContext(officeKey);
  let insertionIndex = chatCtx.items.findIndex((item) =>
    item.id.startsWith(OFFICE_KNOWLEDGE_MESSAGE_ID_PREFIX),
  );
  chatCtx.items = chatCtx.items.filter(
    (item) => !item.id.startsWith(OFFICE_KNOWLEDGE_MESSAGE_ID_PREFIX),
  );
  if (insertionIndex < 0) insertionIndex = chatCtx.items.length;
  chatCtx.items.splice(
    Math.min(insertionIndex, chatCtx.items.length),
    0,
    ChatMessage.create({
      id: `${OFFICE_KNOWLEDGE_MESSAGE_ID_PREFIX}${context.documentHash}`,
      role: "system",
      content: [
        "=== ACTIVE OFFICE KNOWLEDGE CONTEXT ===",
        `document hash: ${context.documentHash}`,
        "This customer-authored document is authoritative for public office facts.",
        "It does not prove insurance acceptance, appointment availability, patient state, or a completed operation. Use the owning tool for those outcomes.",
        "",
        context.content,
        "=== END ACTIVE OFFICE KNOWLEDGE CONTEXT ===",
      ].join("\n"),
    }),
  );
  return context;
}

function setPatientModelContext(
  chatCtx: ChatContext,
  state: CallState,
  content: string | null,
): void {
  let insertionIndex = chatCtx.items.findIndex((item) =>
    item.id.startsWith(PATIENT_CONTEXT_MESSAGE_ID_PREFIX),
  );
  chatCtx.items = chatCtx.items.filter(
    (item) => !item.id.startsWith(PATIENT_CONTEXT_MESSAGE_ID_PREFIX),
  );
  if (!content) return;

  if (insertionIndex < 0) {
    insertionIndex = chatCtx.items.length - 1;
    while (insertionIndex >= 0) {
      const item = chatCtx.items[insertionIndex];
      if (item.type === "message" && item.role === "user") break;
      insertionIndex -= 1;
    }
  }
  if (insertionIndex < 0) insertionIndex = chatCtx.items.length;

  chatCtx.items.splice(
    insertionIndex,
    0,
    ChatMessage.create({
      id: patientContextMessageId(state),
      role: "system",
      content,
    }),
  );
}

function refreshPatientModelContext(
  chatCtx: ChatContext,
  state: CallState,
): void {
  if (chatCtx.getById(patientContextMessageId(state))) return;
  setPatientModelContext(chatCtx, state, confirmedPatientModelContext(state));
}

function patientContextMessageId(state: CallState): string {
  return `${PATIENT_CONTEXT_MESSAGE_ID_PREFIX}${state.identity.transitionVersion}`;
}

export async function* observeAssistantText(
  chunks: AsyncIterable<string>,
  observer: (text: string, complete: boolean) => void,
): AsyncIterable<string> {
  let text = "";

  for await (const chunk of chunks) {
    text += chunk;
    observer(text, false);
    yield chunk;
  }

  observer(text, true);
}
