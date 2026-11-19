export type MutationOutcome = { ok: true } | { ok: false; message: string };

export const DEFAULT_MUTATION_ERROR = "Could not save the comment.";

export async function attemptMutation(
  run: () => Promise<unknown>,
  fallback = DEFAULT_MUTATION_ERROR,
): Promise<MutationOutcome> {
  try {
    await run();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message.trim() : "";
    return { ok: false, message: message === "" ? fallback : message };
  }
}
