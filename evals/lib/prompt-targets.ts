export interface PromptTargetSignal {
  source: "eval" | "audit";
  suiteOrBucket: string;
  issue: string;
  count: number;
}

export interface PromptTarget {
  key: string;
  suiteOrBucket: string;
  issue: string;
  priority: number;
  promptability: "high" | "medium";
  targetFile: "RUNBOOK.md" | "VOICE.md" | "SOUL.md";
  targetSections: string[];
  strategy: string;
  guidance: string;
  codeFollowup?: string;
  signals: PromptTargetSignal[];
}

export interface CodeFirstBacklogItem {
  key: string;
  suiteOrBucket: string;
  issue: string;
  reason: string;
  suggestedOwner: string;
  signals: PromptTargetSignal[];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function matches(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern));
}

function dedupeSections(sections: string[]): string[] {
  return Array.from(new Set(sections));
}

function makeTarget(
  signal: PromptTargetSignal,
  config: Omit<PromptTarget, "key" | "issue" | "suiteOrBucket" | "signals">,
): PromptTarget {
  return {
    key: `${config.targetFile}:${config.targetSections.join("|")}:${normalize(signal.issue)}`,
    suiteOrBucket: signal.suiteOrBucket,
    issue: signal.issue,
    signals: [signal],
    ...config,
    targetSections: dedupeSections(config.targetSections),
  };
}

function makeBacklog(
  signal: PromptTargetSignal,
  reason: string,
  suggestedOwner: string,
): CodeFirstBacklogItem {
  return {
    key: `${suggestedOwner}:${normalize(signal.issue)}`,
    suiteOrBucket: signal.suiteOrBucket,
    issue: signal.issue,
    reason,
    suggestedOwner,
    signals: [signal],
  };
}

function classifySignal(
  signal: PromptTargetSignal,
): PromptTarget | CodeFirstBacklogItem {
  const issue = normalize(signal.issue);
  const suite = normalize(signal.suiteOrBucket);

  if (matches(issue, ["confirm_appt"]) || suite === "confirm") {
    return makeTarget(signal, {
      priority: 100,
      promptability: "high",
      targetFile: "RUNBOOK.md",
      targetSections: ["Path 1: Existing Patient", "Tool Use Rules"],
      strategy:
        "Clarify exactly when caller context is sufficient and when confirm_appt is mandatory before reading back appointments.",
      guidance:
        "State that confirmed appointment details may be read from verified caller context for the same patient; otherwise confirm_appt must be called before the agent gives date, time, provider, or location.",
      codeFollowup:
        "Mirror the same rule in src/tools.ts confirm_appt description so the tool contract matches the runbook.",
    });
  }

  if (
    matches(issue, [
      "reason for visit",
      "get_availability",
      "redundant tool calls",
      "same input twice",
    ]) ||
    suite === "scheduling"
  ) {
    return makeTarget(signal, {
      priority: 95,
      promptability: "high",
      targetFile: "RUNBOOK.md",
      targetSections: ["Path 1: Existing Patient", "Tool Use Rules"],
      strategy:
        "Make the get_availability preconditions explicit and non-optional.",
      guidance:
        "Tell the agent to ask for the reason for visit before get_availability and to reuse prior availability results instead of calling the same query twice without new information.",
      codeFollowup:
        "Consider enforcing duplicate get_availability detection in eval tooling or wrappers.",
    });
  }

  if (
    matches(issue, [
      "cancel_appt",
      "cancel path missing cancel_appt",
      "cancellation completion",
    ]) ||
    suite === "cancel"
  ) {
    return makeTarget(signal, {
      priority: 92,
      promptability: "high",
      targetFile: "RUNBOOK.md",
      targetSections: ["Path 1: Existing Patient", "Tool Use Rules"],
      strategy:
        "Reinforce that verbal confirmation is not cancellation and the tool result is the source of truth.",
      guidance:
        "Add direct wording that the agent must call cancel_appt after the caller confirms cancellation and must not say the appointment is cancelled until the tool succeeds.",
      codeFollowup:
        "Tighten cancel_appt wrapper language to mirror the same completion rule.",
    });
  }

  if (
    matches(issue, [
      "insurance-gate",
      "check_insurance",
      "insurance acceptance",
      "ambiguous plan",
    ]) ||
    suite === "insurance"
  ) {
    return makeTarget(signal, {
      priority: 90,
      promptability: "high",
      targetFile: "RUNBOOK.md",
      targetSections: [
        "Path 2: New Patient",
        "Path 3: Quick Question",
        "Tool Use Rules",
        "Examples",
      ],
      strategy:
        "Make insurance grounding mandatory and shorthand handling explicit.",
      guidance:
        "State that check_insurance is the only acceptance source of truth, including for shorthand carrier names, and explain when the agent may proceed before the exact card plan name is collected.",
      codeFollowup:
        "Keep insurance alias handling in src/insurance-rules.ts aligned with middleware.",
    });
  }

  if (
    matches(issue, [
      "route_to_spring_hill",
      "routing tool semantics",
      "routing rule violated",
    ]) ||
    suite === "routing"
  ) {
    return makeTarget(signal, {
      priority: 88,
      promptability: "high",
      targetFile: "RUNBOOK.md",
      targetSections: ["Path 4: Transfer", "Tool Use Rules"],
      strategy:
        "Separate internal scheduling reroutes from human/department transfers.",
      guidance:
        "Say that route_to_spring_hill is for scheduling reroutes that stay with the agent, while transfer_call is for human handoffs, departments, or caller insistence on a person.",
      codeFollowup:
        "Align route_to_spring_hill and transfer_call descriptions in src/tools.ts with the same split.",
    });
  }

  if (
    matches(issue, [
      "transfer policy",
      "transfer-billing-immediate",
      'missing required phrase hint "transfer"',
    ]) ||
    suite === "transfer"
  ) {
    return makeTarget(signal, {
      priority: 86,
      promptability: "medium",
      targetFile: "RUNBOOK.md",
      targetSections: ["Path 4: Transfer", "Remember"],
      strategy:
        "Make immediate-transfer triggers and transfer wording easier to follow in one pass.",
      guidance:
        "Use short, direct instructions for immediate transfer categories and keep the transfer preamble sentence fixed and complete before transfer_call.",
      codeFollowup:
        "If transfer_call errors remain frequent, add stronger runtime handling or retries in the tool layer.",
    });
  }

  if (
    matches(issue, [
      "add_patient",
      "readback contract",
      "registration submission",
    ]) ||
    suite === "registration"
  ) {
    return makeTarget(signal, {
      priority: 84,
      promptability: "medium",
      targetFile: "RUNBOOK.md",
      targetSections: ["Path 2: New Patient", "Tool Use Rules"],
      strategy:
        "Tighten the add_patient submission gate around explicit collection and final readback.",
      guidance:
        "Tell the agent not to call add_patient until all required fields were explicitly collected from the caller and name, DOB, exact insurance plan, and member ID were read back and confirmed.",
      codeFollowup:
        "Add wrapper-side validation in src/tools.ts or middleware so incomplete add_patient submissions fail fast.",
    });
  }

  if (
    matches(issue, [
      "reschedule",
      "book before cancel",
      'missing required phrase hint "reason"',
    ]) ||
    suite === "reschedule"
  ) {
    return makeTarget(signal, {
      priority: 82,
      promptability: "medium",
      targetFile: "RUNBOOK.md",
      targetSections: ["Path 1: Existing Patient", "Tool Use Rules"],
      strategy:
        "Make the reschedule order and prerequisites explicit in one compact rule.",
      guidance:
        "State that reschedule requires confirm_appt first, then reason for visit, then get_availability, then book_appt, and only then cancel_appt.",
      codeFollowup:
        "Add eval assertions for reason-before-availability and book-before-cancel ordering.",
    });
  }

  if (suite === "safety" || matches(issue, ["clinical safety", "safety"])) {
    return makeTarget(signal, {
      priority: 75,
      promptability: "medium",
      targetFile: "SOUL.md",
      targetSections: ["How You Work"],
      strategy:
        "Reinforce concise safe escalation and non-diagnostic boundaries.",
      guidance:
        "Keep the agent grounded, avoid medical advice, and escalate or transfer when clinical judgment would be required.",
    });
  }

  return makeBacklog(
    signal,
    "This looks primarily like schema, wrapper, or workflow enforcement rather than a prompt-only issue.",
    "src/tools.ts / eval contracts",
  );
}

function mergePromptTarget(
  existing: PromptTarget,
  incoming: PromptTarget,
): PromptTarget {
  return {
    ...existing,
    priority: Math.max(existing.priority, incoming.priority),
    promptability:
      existing.promptability === "high" || incoming.promptability === "high"
        ? "high"
        : "medium",
    targetSections: dedupeSections([
      ...existing.targetSections,
      ...incoming.targetSections,
    ]),
    signals: [...existing.signals, ...incoming.signals],
  };
}

function mergeBacklog(
  existing: CodeFirstBacklogItem,
  incoming: CodeFirstBacklogItem,
): CodeFirstBacklogItem {
  return {
    ...existing,
    signals: [...existing.signals, ...incoming.signals],
  };
}

export function derivePromptTargets(signals: PromptTargetSignal[]): {
  targets: PromptTarget[];
  backlog: CodeFirstBacklogItem[];
} {
  const targets = new Map<string, PromptTarget>();
  const backlog = new Map<string, CodeFirstBacklogItem>();

  for (const signal of signals) {
    const classified = classifySignal(signal);
    if ("promptability" in classified) {
      const current = targets.get(classified.key);
      targets.set(
        classified.key,
        current ? mergePromptTarget(current, classified) : classified,
      );
    } else {
      const current = backlog.get(classified.key);
      backlog.set(
        classified.key,
        current ? mergeBacklog(current, classified) : classified,
      );
    }
  }

  return {
    targets: Array.from(targets.values()).sort((a, b) => {
      const signalDelta = b.signals.length - a.signals.length;
      if (signalDelta !== 0) return signalDelta;
      return b.priority - a.priority;
    }),
    backlog: Array.from(backlog.values()).sort(
      (a, b) => b.signals.length - a.signals.length,
    ),
  };
}

export function summarizePromptTargets(targets: PromptTarget[]): string {
  if (targets.length === 0) return "(no prompt-eligible targets found)";
  return targets
    .slice(0, 8)
    .map((target, index) => {
      const evidence = target.signals
        .map(
          (signal) =>
            `${signal.source}:${signal.suiteOrBucket}×${signal.count}`,
        )
        .join(", ");
      return [
        `${index + 1}. ${target.suiteOrBucket}: ${target.issue}`,
        `   promptability=${target.promptability} priority=${target.priority}`,
        `   target=${target.targetFile} :: ${target.targetSections.join(" | ")}`,
        `   strategy=${target.strategy}`,
        `   guidance=${target.guidance}`,
        `   evidence=${evidence}`,
        target.codeFollowup ? `   code_followup=${target.codeFollowup}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}

export function summarizeCodeBacklog(backlog: CodeFirstBacklogItem[]): string {
  if (backlog.length === 0) return "(no code-first backlog)";
  return backlog
    .slice(0, 8)
    .map((item) => {
      const evidence = item.signals
        .map(
          (signal) =>
            `${signal.source}:${signal.suiteOrBucket}×${signal.count}`,
        )
        .join(", ");
      return [
        `- ${item.suiteOrBucket}: ${item.issue}`,
        `  owner=${item.suggestedOwner}`,
        `  reason=${item.reason}`,
        `  evidence=${evidence}`,
      ].join("\n");
    })
    .join("\n");
}
