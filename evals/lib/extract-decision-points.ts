import type { DecisionPointCase, NormalizedCallEvent, NormalizedTurn } from "./types.js";

function inferPhoneLookupStatus(record: NormalizedCallEvent): DecisionPointCase["context"]["phoneLookupStatus"] {
  if (record.data.phoneLookupStatus) return record.data.phoneLookupStatus;

  const text = record.data.turns
    .flatMap((turn) => [turn.callerText, turn.agentText])
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();

  if (text.includes("few patients associated with this number")) return "multiple_matches";
  if (text.includes("not finding you in our system") || text.includes("have you been seen here before")) return "no_match";
  return "unknown";
}

function buildConversationBeforeDecision(turns: NormalizedTurn[], currentTurnIndex: number): DecisionPointCase["conversation"] {
  const conversation: DecisionPointCase["conversation"] = [];

  for (let i = 0; i < currentTurnIndex; i += 1) {
    const turn = turns[i];
    if (turn.callerText) {
      conversation.push({ role: "user", content: turn.callerText });
    }
    if (turn.agentText) {
      conversation.push({ role: "assistant", content: turn.agentText });
    }
  }

  const currentTurn = turns[currentTurnIndex];
  if (currentTurn.callerText) {
    conversation.push({ role: "user", content: currentTurn.callerText });
  }

  return conversation;
}

function makeBaseContext(record: NormalizedCallEvent) {
  return {
    trunkPhone: record.officePhone,
    phoneLookupStatus: inferPhoneLookupStatus(record),
  };
}

function humanRequest(text: string | null): boolean {
  if (!text) return false;
  return /\b(human|person|representative|someone|real person|live representative)\b/i.test(text);
}

function multipleMatchPrompt(text: string | null): boolean {
  if (!text) return false;
  return /few patients associated with this number/i.test(text);
}

function previousSchedulingPushback(turns: NormalizedTurn[], currentTurnIndex: number): boolean {
  for (let i = currentTurnIndex - 1; i >= 0; i -= 1) {
    const text = turns[i].agentText ?? "";
    if (/I can book appointments right now|let'?s get you scheduled|I can help you right here/i.test(text)) {
      return true;
    }
  }
  return false;
}

function spanishCallerText(text: string | null): boolean {
  if (!text) return false;
  // Conservative: words that almost never appear in English transcripts
  return /\b(hola|necesito|por favor|gracias|cita|doctor[ae]s?|español|habl[ao]|estoy|tengo)\b/i.test(text);
}

function askedReasonBefore(turns: NormalizedTurn[], currentTurnIndex: number): boolean {
  for (let i = currentTurnIndex - 1; i >= 0; i -= 1) {
    const text = turns[i].agentText ?? "";
    if (/reason for (your |the )?visit|what'?s bringing you in|what brings you in|what'?s the reason/i.test(text)) {
      return true;
    }
  }
  return false;
}

function previousToolNames(turns: NormalizedTurn[], currentTurnIndex: number): Set<string> {
  const seen = new Set<string>();
  for (let i = 0; i < currentTurnIndex; i += 1) {
    for (const toolCall of turns[i].toolCalls) seen.add(toolCall.name);
  }
  return seen;
}

export function extractDecisionPointCases(record: NormalizedCallEvent): DecisionPointCase[] {
  const cases: DecisionPointCase[] = [];
  const baseContext = makeBaseContext(record);

  record.data.turns.forEach((turn, index) => {
    const toolNames = turn.toolCalls.map((toolCall) => toolCall.name);
    const conversation = buildConversationBeforeDecision(record.data.turns, index);

    if (multipleMatchPrompt(turn.agentText)) {
      cases.push({
        id: `${record.callId}-multiple-matches-turn-${turn.turn}`,
        suite: "verification",
        source: "livekit-trace",
        traceId: record.callId,
        tags: ["verification", "multiple-matches", "hipaa"],
        context: {
          ...baseContext,
          notes: "Extracted from a multiple-match phone lookup flow.",
        },
        conversation,
        expectations: {
          mustCallTools: [],
          mustNotCallTools: ["confirm_appt", "get_availability", "book_appt"],
          mustSay: ["first name"],
          mustNotSay: ["date of birth", "last name"],
          policyFlags: ["do_not_read_back_known_names"],
          styleFlags: ["concise"],
        },
      });
    }

    if (toolNames.includes("route_to_spring_hill")) {
      cases.push({
        id: `${record.callId}-route-to-spring-hill-turn-${turn.turn}`,
        suite: "routing",
        source: "livekit-trace",
        traceId: record.callId,
        tags: ["routing", "crystal-river", "spring-hill"],
        context: {
          ...baseContext,
          notes: "Extracted from a call where AMD routing switched to Spring Hill without transfer.",
        },
        conversation,
        expectations: {
          mustCallTools: ["route_to_spring_hill"],
          mustNotCallTools: ["transfer_call"],
          policyFlags: ["no_transfer_for_internal_office_reroute"],
          styleFlags: ["confident", "concise"],
        },
      });
    }

    if (toolNames.includes("transfer_call")) {
      const tags = humanRequest(turn.callerText) ? ["transfer", "human-request"] : ["transfer"];
      const policyFlags = humanRequest(turn.callerText)
        ? previousSchedulingPushback(record.data.turns, index)
          ? ["caller_requested_human", "no_second_pushback"]
          : ["caller_requested_human"]
        : ["transfer_required"];

      cases.push({
        id: `${record.callId}-transfer-turn-${turn.turn}`,
        suite: "transfer",
        source: "livekit-trace",
        traceId: record.callId,
        tags,
        context: {
          ...baseContext,
          notes: "Extracted from a call that transferred to a human.",
        },
        conversation,
        expectations: {
          mustCallTools: ["transfer_call"],
          mustNotCallTools: [],
          policyFlags: [...policyFlags, "speak_full_transfer_message_before_call"],
          styleFlags: [],
        },
      });
    }

    if (toolNames.includes("add_patient")) {
      cases.push({
        id: `${record.callId}-registration-turn-${turn.turn}`,
        suite: "registration",
        source: "livekit-trace",
        traceId: record.callId,
        tags: ["registration", "no-fabrication", "needs-review"],
        context: {
          ...baseContext,
          notes: "Real call where the agent submitted a new patient. Verify no fabricated fields and that registration order was followed.",
        },
        conversation,
        expectations: {
          mustCallTools: ["add_patient"],
          mustNotCallTools: [],
          policyFlags: ["never_call_add_patient_without_all_fields"],
          styleFlags: ["concise"],
        },
      });
    }

    if (toolNames.includes("verify_patient")) {
      const previousTools = previousToolNames(record.data.turns, index);
      const isFirstVerify = !previousTools.has("verify_patient");
      cases.push({
        id: `${record.callId}-verify-turn-${turn.turn}`,
        suite: "verification",
        source: "livekit-trace",
        traceId: record.callId,
        tags: ["verification", "needs-review"],
        context: {
          ...baseContext,
          notes: isFirstVerify
            ? "Real call: agent's first verify_patient invocation. Check that lookup context was respected (skip if pre-verified) and only first name asked for multi-match."
            : "Real call: agent re-ran verify_patient. Check whether retry was necessary or wasteful.",
        },
        conversation,
        expectations: {
          mustCallTools: ["verify_patient"],
          mustNotCallTools: [],
          policyFlags:
            baseContext.phoneLookupStatus === "multiple_matches"
              ? ["narrow_with_first_name_only", "do_not_read_back_known_names"]
              : [],
          styleFlags: ["concise"],
        },
      });
    }

    if (toolNames.includes("get_availability")) {
      const reasonAsked = askedReasonBefore(record.data.turns, index);
      cases.push({
        id: `${record.callId}-scheduling-turn-${turn.turn}`,
        suite: "scheduling",
        source: "livekit-trace",
        traceId: record.callId,
        tags: ["scheduling", "needs-review", ...(reasonAsked ? [] : ["missing-reason"])],
        context: {
          ...baseContext,
          notes: reasonAsked
            ? "Real call: agent asked the reason for visit before checking availability."
            : "Real call: agent jumped to get_availability without asking the reason for visit.",
        },
        conversation,
        expectations: {
          mustCallTools: reasonAsked ? ["get_availability"] : [],
          mustNotCallTools: reasonAsked ? [] : ["get_availability"],
          policyFlags: ["ask_reason_before_get_availability"],
          styleFlags: ["concise"],
        },
      });
    }

    if (toolNames.includes("cancel_appt")) {
      cases.push({
        id: `${record.callId}-cancel-turn-${turn.turn}`,
        suite: "cancel",
        source: "livekit-trace",
        traceId: record.callId,
        tags: ["cancel", "needs-review"],
        context: {
          ...baseContext,
          notes: "Real call: agent cancelled an appointment. Check that cancel_appt was actually called rather than just verbally agreed.",
        },
        conversation,
        expectations: {
          mustCallTools: ["cancel_appt"],
          mustNotCallTools: [],
          policyFlags: ["cancel_requires_tool_call"],
          styleFlags: ["concise"],
        },
      });
    }

    if (toolNames.includes("confirm_appt")) {
      cases.push({
        id: `${record.callId}-confirm-turn-${turn.turn}`,
        suite: "confirm",
        source: "livekit-trace",
        traceId: record.callId,
        tags: ["confirm", "needs-review"],
        context: {
          ...baseContext,
          notes: "Real call: agent fetched appointments to confirm an existing visit. Check that confirm_appt was used only after verifying the patient and that the confirmation path stayed concise.",
        },
        conversation,
        expectations: {
          mustCallTools: ["confirm_appt"],
          mustNotCallTools: [],
          policyFlags: [],
          styleFlags: ["concise"],
        },
      });
    }

    if (toolNames.includes("lookup_knowledge")) {
      cases.push({
        id: `${record.callId}-quick-question-turn-${turn.turn}`,
        suite: "quick-question",
        source: "livekit-trace",
        traceId: record.callId,
        tags: ["quick-question", "knowledge", "needs-review"],
        context: {
          ...baseContext,
          notes: "Real call: agent looked up knowledge for a question. Check answer was grounded in lookup result, not invented.",
        },
        conversation,
        expectations: {
          mustCallTools: ["lookup_knowledge"],
          mustNotCallTools: [],
          policyFlags: [],
          styleFlags: ["concise"],
        },
      });
    }

    if (spanishCallerText(turn.callerText)) {
      cases.push({
        id: `${record.callId}-language-turn-${turn.turn}`,
        suite: "language",
        source: "livekit-trace",
        traceId: record.callId,
        tags: ["language", "spanish", "needs-review"],
        context: {
          ...baseContext,
          notes: "Real call: caller spoke Spanish. Check the agent replied in Spanish, not English.",
        },
        conversation,
        expectations: {
          mustCallTools: [],
          mustNotCallTools: [],
          policyFlags: ["match_caller_language"],
          styleFlags: ["responds_in_spanish", "concise"],
        },
      });
    }
  });

  return cases;
}
