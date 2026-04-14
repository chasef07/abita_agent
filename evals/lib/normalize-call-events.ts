import type { NormalizedCallEvent } from "./types.js";

type ExportedCallEventRow = {
  callId: string;
  officePhone: string;
  totalTurns?: number | string;
  durationSec?: number | string;
  startedAt?: string;
  endedAt?: string;
  data: unknown;
};

function parseIntIfPresent(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.length > 0) return Number.parseInt(value, 10);
  return undefined;
}

function parseData(data: unknown): NormalizedCallEvent["data"] {
  if (typeof data === "string") {
    return JSON.parse(data) as NormalizedCallEvent["data"];
  }
  return data as NormalizedCallEvent["data"];
}

function isNormalizedCallEvent(value: unknown): value is NormalizedCallEvent {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.callId === "string"
    && typeof record.officePhone === "string"
    && Boolean(record.data)
    && typeof record.data === "object"
    && Array.isArray((record.data as Record<string, unknown>).turns);
}

function normalizeOne(value: unknown): NormalizedCallEvent {
  if (isNormalizedCallEvent(value)) {
    return value;
  }

  const row = value as ExportedCallEventRow;
  return {
    callId: row.callId,
    officePhone: row.officePhone,
    totalTurns: parseIntIfPresent(row.totalTurns),
    durationSec: parseIntIfPresent(row.durationSec),
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    data: parseData(row.data),
  };
}

export function normalizeCallEvents(value: unknown): NormalizedCallEvent[] {
  if (Array.isArray(value)) {
    return value.map(normalizeOne);
  }
  return [normalizeOne(value)];
}
