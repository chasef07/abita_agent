// call-logger.ts — Per-call analytics: turn tracking, metrics, and optional webhook.

import { voice } from "@livekit/agents";

// --- Types ---

interface ToolCallRecord {
  name: string;
  args: string;
  result: string;
  durationMs: number;
  isError: boolean;
}

interface TurnRecord {
  turn: number;
  callerText: string | null;
  agentText: string | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  eouDelayMs: number;
  asrDelayMs: number;
  ttftMs: number;
  ttsttfbMs: number;
  toolCalls: ToolCallRecord[];
}

interface CallSummary {
  callId: string;
  callerPhone: string;
  officePhone: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  totalTurns: number;
  totals: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheHitRate: number;
    peakContextTokens: number;
    toolCalls: number;
    toolErrors: number;
    avgASR: number;
    avgTTFT: number;
    avgTTSttfb: number;
  };
  turns: TurnRecord[];
}

// --- CallLogger ---

export class CallLogger {
  private readonly callId: string;
  private readonly callerPhone: string;
  private readonly officePhone: string;
  private readonly startedAt: Date;

  private turns: TurnRecord[] = [];
  private currentTurn: TurnRecord | null = null;
  private turnCounter = 0;

  // Per-turn metrics (kept for per-turn analytics)
  private asrValues: number[] = [];
  private ttftValues: number[] = [];
  private ttsttfbValues: number[] = [];
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCachedTokens = 0;
  private peakContextTokens = 0;
  private totalToolCalls = 0;
  private totalToolErrors = 0;

  constructor(
    session: voice.AgentSession,
    opts: { callId: string; callerPhone: string; officePhone: string },
  ) {
    this.callId = opts.callId;
    this.callerPhone = opts.callerPhone;
    this.officePhone = opts.officePhone;
    this.startedAt = new Date();

    session.on(
      voice.AgentSessionEventTypes.UserInputTranscribed,
      (ev: any) => this.onUserInputTranscribed(ev),
    );
    session.on(
      voice.AgentSessionEventTypes.ConversationItemAdded,
      (ev: any) => this.onConversationItemAdded(ev),
    );
    session.on(
      voice.AgentSessionEventTypes.MetricsCollected,
      (ev: any) => this.onMetricsCollected(ev),
    );
    session.on(
      voice.AgentSessionEventTypes.FunctionToolsExecuted,
      (ev: any) => this.onFunctionToolsExecuted(ev),
    );
    session.on(
      voice.AgentSessionEventTypes.Close,
      (ev: any) => this.onClose(ev),
    );
  }

  // --- Event handlers ---

  private onUserInputTranscribed(ev: any): void {
    if (!ev.isFinal) return;

    // Finalize previous turn
    if (this.currentTurn) {
      this.turns.push(this.currentTurn);
    }

    this.turnCounter++;
    this.currentTurn = {
      turn: this.turnCounter,
      callerText: ev.transcript,
      agentText: null,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      eouDelayMs: 0,
      asrDelayMs: 0,
      ttftMs: 0,
      ttsttfbMs: 0,
      toolCalls: [],
    };
  }

  private onConversationItemAdded(ev: any): void {
    if (ev.item?.role !== "assistant" || !ev.item.textContent) return;
    const turn = this.ensureCurrentTurn();
    turn.agentText = ev.item.textContent;
  }

  private onMetricsCollected(ev: any): void {
    const m = ev.metrics;

    if (m.type === "llm_metrics") {
      console.log(
        `[llm] ${m.promptTokens} in / ${m.completionTokens} out` +
        ` / cached: ${m.promptCachedTokens}` +
        ` / TTFT: ${m.ttftMs}ms` +
        ` / ${m.tokensPerSecond.toFixed(0)} tok/s`,
      );

      const turn = this.ensureCurrentTurn();
      turn.promptTokens = m.promptTokens;
      turn.completionTokens = m.completionTokens;
      turn.cachedTokens = m.promptCachedTokens;
      turn.ttftMs = m.ttftMs;

      this.totalInputTokens += m.promptTokens;
      this.totalOutputTokens += m.completionTokens;
      this.totalCachedTokens += m.promptCachedTokens;
      this.ttftValues.push(m.ttftMs);

      if (m.promptTokens > this.peakContextTokens) {
        this.peakContextTokens = m.promptTokens;
      }
    }

    if (m.type === "tts_metrics") {
      console.log(`[tts] TTFB: ${m.ttfbMs}ms / ${m.charactersCount} chars`);

      const turn = this.ensureCurrentTurn();
      turn.ttsttfbMs = m.ttfbMs;
      this.ttsttfbValues.push(m.ttfbMs);
    }

    if (m.type === "stt_metrics") {
      const durationMs = Math.round(m.durationMs ?? 0);
      if (durationMs > 0) {
        console.log(`[stt] duration: ${durationMs}ms / audio: ${Math.round(m.audioDurationMs ?? 0)}ms / streamed: ${m.streamed}`);
        const turn = this.ensureCurrentTurn();
        turn.asrDelayMs = durationMs;
        this.asrValues.push(durationMs);
      }
    }

    if (m.type === "eou_metrics") {
      const eouMs = Math.round(m.endOfUtteranceDelayMs ?? 0);
      if (eouMs > 0) {
        console.log(`[asr] EOU: ${eouMs}ms`);
        const turn = this.ensureCurrentTurn();
        turn.eouDelayMs = eouMs;
      }
    }
  }

  private onFunctionToolsExecuted(ev: any): void {
    const calls: any[] = ev.functionCalls ?? [];
    const outputs: any[] = ev.functionCallOutputs ?? [];

    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const output = outputs[i];
      const durationMs = output?.createdAt && call?.createdAt
        ? output.createdAt - call.createdAt
        : 0;
      const isError = output?.isError ?? false;
      const name = call?.name ?? "unknown";
      const args = call?.args ?? "";
      const result = output?.output ?? "";

      console.log(
        `[tool] ${name} ${isError ? "\u2717" : "\u2713"} ${durationMs}ms`,
      );

      const record: ToolCallRecord = { name, args, result, durationMs, isError };
      const turn = this.ensureCurrentTurn();
      turn.toolCalls.push(record);

      this.totalToolCalls++;
      if (isError) this.totalToolErrors++;
    }
  }

  private onClose(_ev: any): void {
    this.flush();
  }

  // --- Public API ---

  /** Record a tool call directly (for tools that disconnect the session before FunctionToolsExecuted fires). */
  recordToolCall(record: ToolCallRecord): void {
    const turn = this.ensureCurrentTurn();
    turn.toolCalls.push(record);
    this.totalToolCalls++;
    if (record.isError) this.totalToolErrors++;
    console.log(`[tool] ${record.name} ${record.isError ? "\u2717" : "\u2713"} ${record.durationMs}ms (direct)`);
  }

  private flushed = false;

  /** Force summary + webhook if the Close event never fired (e.g. crash). */
  async flush(): Promise<void> {
    if (this.flushed) return;
    this.flushed = true;

    if (this.currentTurn) {
      this.turns.push(this.currentTurn);
      this.currentTurn = null;
    }

    const summary = this.buildSummary();
    this.printSummary(summary);
    await this.postWebhook(summary);
  }

  // --- Internals ---

  private ensureCurrentTurn(): TurnRecord {
    if (!this.currentTurn) {
      this.turnCounter++;
      this.currentTurn = {
        turn: this.turnCounter,
        callerText: null,
        agentText: null,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        eouDelayMs: 0,
        asrDelayMs: 0,
        ttftMs: 0,
        ttsttfbMs: 0,
        toolCalls: [],
      };
    }
    return this.currentTurn!;
  }

  private buildSummary(): CallSummary {
    const endedAt = new Date();
    const durationSec = (endedAt.getTime() - this.startedAt.getTime()) / 1000;
    const cacheHitRate =
      this.totalInputTokens > 0
        ? this.totalCachedTokens / this.totalInputTokens
        : 0;
    const avgASR = this.asrValues.length > 0
      ? this.asrValues.reduce((a, b) => a + b, 0) / this.asrValues.length
      : 0;
    const avgTTFT = this.ttftValues.length > 0
      ? this.ttftValues.reduce((a, b) => a + b, 0) / this.ttftValues.length
      : 0;
    const avgTTSttfb = this.ttsttfbValues.length > 0
      ? this.ttsttfbValues.reduce((a, b) => a + b, 0) / this.ttsttfbValues.length
      : 0;

    return {
      callId: this.callId,
      callerPhone: this.callerPhone,
      officePhone: this.officePhone,
      startedAt: this.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationSec: Math.round(durationSec),
      totalTurns: this.turns.length,
      totals: {
        inputTokens: this.totalInputTokens,
        outputTokens: this.totalOutputTokens,
        cachedTokens: this.totalCachedTokens,
        cacheHitRate,
        peakContextTokens: this.peakContextTokens,
        toolCalls: this.totalToolCalls,
        toolErrors: this.totalToolErrors,
        avgASR: Math.round(avgASR),
        avgTTFT: Math.round(avgTTFT),
        avgTTSttfb: Math.round(avgTTSttfb),
      },
      turns: this.turns,
    };
  }

  private printSummary(summary: CallSummary): void {
    const t = summary.totals;
    console.log(
      `[call] Ended — ${summary.totalTurns} turns, ${summary.durationSec}s\n` +
      `  tokens: ${t.inputTokens} in / ${t.outputTokens} out / ${t.cachedTokens} cached\n` +
      `  cache hit rate: ${(t.cacheHitRate * 100).toFixed(1)}%\n` +
      `  peak context: ${t.peakContextTokens} tokens\n` +
      `  tools: ${t.toolCalls} calls, ${t.toolErrors} errors\n` +
      `  avg ASR: ${t.avgASR}ms, avg TTFT: ${t.avgTTFT}ms, avg TTS TTFB: ${t.avgTTSttfb}ms`,
    );
  }

  private async postWebhook(summary: CallSummary): Promise<void> {
    const url = process.env.ANALYTICS_URL;
    if (!url) return;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const secret = process.env.WEBHOOK_SECRET;
    if (secret) {
      headers["Authorization"] = `Bearer ${secret}`;
    }

    const payload = JSON.stringify(summary);

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: payload,
          signal: AbortSignal.timeout(30_000),
        });
        if (res.ok) {
          console.log(`[call] Analytics POST succeeded (attempt ${attempt})`);
          return;
        }
        console.warn(`[call] Analytics POST returned ${res.status} (attempt ${attempt})`);
      } catch (err) {
        console.warn(`[call] Analytics POST failed (attempt ${attempt}):`, err);
      }
      // Wait 2s before retry
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}
