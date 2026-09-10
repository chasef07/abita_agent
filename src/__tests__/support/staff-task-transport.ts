// An inert HTTP boundary for the actual tool. No delegation to global fetch.
export function captureStaffTaskTransport() {
  const payloads: Array<Record<string, unknown>> = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    if (
      String(url) !== "https://staff-task.invalid/v1/tasks" ||
      init?.method !== "POST" ||
      typeof init.body !== "string"
    ) {
      throw new Error(
        "Synthetic task transport rejected an unexpected request",
      );
    }
    payloads.push(JSON.parse(init.body));
    return Response.json(
      { status: "created", taskId: `synthetic-task-${payloads.length}` },
      { status: 201 },
    );
  };
  return { fetch, payloads };
}
