import type { CallFlowState, WorkflowCommand } from "../types.js";
import { command, genericPlan, operationalBlockedActions } from "./common.js";

export function planKnowledgeAnswer(flow: CallFlowState): WorkflowCommand {
  const plan = genericPlan(
    flow,
    "knowledge_answer",
    "answer the caller's informational question from practice knowledge",
    "answering",
  );
  return command(flow, plan, {
    phase: "answering",
    knownFacts: [
      {
        key: "office",
        value: flow.officeKey,
      },
    ],
    missingFacts: [
      {
        key: "knowledgeLookup",
        label: "practice knowledge answer",
      },
    ],
    nextAction: "call_tool",
    tool: "lookup_knowledge",
    args: {},
    allowedTools: ["lookup_knowledge"],
    blockedActions: operationalBlockedActions(
      "informational questions must not trigger patient side effects",
    ),
    instruction: "Call lookup_knowledge for the caller's question.",
    step: "answer",
  });
}

export function planTransfer(flow: CallFlowState): WorkflowCommand {
  const plan = genericPlan(
    flow,
    "transfer",
    "route the caller to the office",
    "transferring",
  );
  if (shouldPushBackTransferDuringScheduling(flow)) {
    const resumed = schedulingTaskToResume(flow);
    return command(flow, plan, {
      phase: "pushback_offered",
      knownFacts: [
        { key: "recoverableTask", value: resumed?.kind ?? "scheduling" },
      ],
      missingFacts: [],
      nextAction: "respond",
      allowedTools: [],
      blockedActions: [
        {
          action: "transfer_call",
          reason:
            "first human request during recoverable scheduling gets one help-first pushback",
        },
      ],
      instruction:
        "Acknowledge the request, explain you can help finish scheduling, and continue the scheduling path. Transfer only if they ask again.",
      step: resumed?.step ?? "get_availability",
    });
  }

  return command(flow, plan, {
    phase: "transferring",
    knownFacts: [{ key: "transferRequested", value: "true" }],
    missingFacts: [],
    nextAction: "call_tool",
    tool: "transfer_call",
    args: {},
    allowedTools: ["transfer_call"],
    blockedActions: [
      {
        action: "book_appt",
        reason: "caller is being transferred",
      },
    ],
    instruction:
      'Say "I\'m going to transfer you to the office now. They may be with a patient, so please leave a message and we will get back to you as soon as possible." Then call transfer_call once.',
    step: "handoff",
  });
}

export function planIntentTriage(flow: CallFlowState): WorkflowCommand {
  const plan = genericPlan(
    flow,
    "intent_triage",
    "identify the caller's request before exposing operational tools",
    "clarifying_intent",
  );
  return command(flow, plan, {
    phase: "clarifying_intent",
    knownFacts: [
      {
        key: "office",
        value: flow.officeKey,
      },
    ],
    missingFacts: [
      {
        key: "intent",
        label: "specific caller goal",
      },
    ],
    nextAction: "ask",
    slot: "intent",
    allowedTools: [],
    blockedActions: operationalBlockedActions(
      "intent must be clear before operational tools are used",
    ),
    instruction:
      "Ask one short clarifying question before changing workflow state.",
    step: "understand_intent",
  });
}

function shouldPushBackTransferDuringScheduling(flow: CallFlowState): boolean {
  return (
    !flow.completedSteps.includes("transfer_pushback_offered") &&
    Boolean(schedulingTaskToResume(flow))
  );
}

function schedulingTaskToResume(flow: CallFlowState) {
  if (flow.currentTask?.kind === "schedule") return flow.currentTask;
  const returnTo = flow.currentTask?.returnTo;
  return [...flow.taskStack]
    .reverse()
    .find(
      (task) => task.kind === "schedule" && (!returnTo || task.id === returnTo),
    );
}
