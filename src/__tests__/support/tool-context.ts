import { vi } from "vitest";

export function createToolContext<T>(state: T) {
  const speechHandle = { allowInterruptions: true };
  return {
    session: { userData: state },
    speechHandle,
    disallowInterruptions: vi.fn(() => {
      speechHandle.allowInterruptions = false;
    }),
  };
}
