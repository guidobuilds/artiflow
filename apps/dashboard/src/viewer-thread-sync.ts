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

export const viewportAnchor = (docY: number, scrollY: number, frameTop: number, marginTop: number): number =>
  Math.round(docY - scrollY + (frameTop - marginTop));

export const DRAFT_FLAG_SELECTOR = "[data-comment-draft='typed'], [data-comment-input='typed']";

export type DraftFlagSource = { querySelector: (selector: string) => unknown };

export type DraftFlagTarget = { dataset: Record<string, string | undefined> };

export const draftFlagOf = (source: DraftFlagSource): "typed" | null =>
  source.querySelector(DRAFT_FLAG_SELECTOR) === null ? null : "typed";

export function publishDraftFlag(source: DraftFlagSource, target: DraftFlagTarget): "typed" | null {
  const flag = draftFlagOf(source);
  if (flag === null) delete target.dataset.commentDraft;
  else target.dataset.commentDraft = flag;
  return flag;
}

export const REVISION_STALE_ATTRIBUTE = "revisionStale";

export const republishedSince = (target: DraftFlagTarget): boolean => {
  const value = target.dataset[REVISION_STALE_ATTRIBUTE];
  return value !== undefined && value !== "";
};

export const createSequenceGuard = (): { next: () => number; isCurrent: (token: number) => boolean } => {
  let latest = 0;
  return {
    next: () => ++latest,
    isCurrent: (token) => token === latest,
  };
};

export type RefetchDeps<T> = {
  guard: { next: () => number; isCurrent: (token: number) => boolean };
  load: () => Promise<T>;
  apply: (value: T) => void;
  fail: (message: string) => void;
  describe?: (error: unknown) => string;
};

export function createThreadsRefetcher<T>({
  guard,
  load,
  apply,
  fail,
  describe = (error) => (error instanceof Error ? error.message : "Could not refresh the comments."),
}: RefetchDeps<T>): () => Promise<void> {
  return async (): Promise<void> => {
    const token = guard.next();
    try {
      const value = await load();
      if (!guard.isCurrent(token)) return;
      apply(value);
    } catch (error) {
      if (!guard.isCurrent(token)) return;
      fail(describe(error));
    }
  };
}
