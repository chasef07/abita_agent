export class SchedulingInputRequired extends Error {}

export async function returnSchedulingInputRequired(
  operation: () => Promise<string>,
): Promise<string> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SchedulingInputRequired) return error.message;
    throw error;
  }
}
