export type ThreadsResponse<T> = { canComment: boolean; threads: T[] };

export function parseThreadsResponse<T extends { id: string }>(raw: unknown): ThreadsResponse<T> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { canComment, threads } = raw as { canComment?: unknown; threads?: unknown };
  if (typeof canComment !== "boolean" || !Array.isArray(threads)) return null;
  for (const thread of threads) {
    if (typeof thread !== "object" || thread === null) return null;
    if (typeof (thread as { id?: unknown }).id !== "string") return null;
  }
  return { canComment, threads: threads as T[] };
}

export const reconcileActive = (activeId: string | null, threads: { id: string }[]): string | null =>
  activeId !== null && threads.some((thread) => thread.id === activeId) ? activeId : null;
