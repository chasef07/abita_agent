type TimestampInput = number | string | Date | undefined;

export type SttProfileTransitionAnalytics = {
  createdAt: string;
  from: string | null;
  reason: string;
  to: string;
};

export function snapshotSttProfileTransition(input: {
  createdAt?: TimestampInput;
  from: string | null;
  reason: string;
  to: string;
}): SttProfileTransitionAnalytics {
  return {
    createdAt: timestampToIso(input.createdAt),
    from: input.from,
    reason: input.reason,
    to: input.to,
  };
}

function timestampToIso(value: TimestampInput): string {
  if (value instanceof Date) return value.toISOString();

  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    return new Date(milliseconds).toISOString();
  }

  return new Date().toISOString();
}
