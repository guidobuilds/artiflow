export const COMMENTS_VISIBLE_KEY = "artiflow:comments-visible";

type Reader = { getItem(key: string): string | null };
type Writer = { setItem(key: string, value: string): void };

export function readCommentsVisible(storage: Reader | null | undefined): boolean {
  try {
    return storage?.getItem(COMMENTS_VISIBLE_KEY) !== "hidden";
  } catch {
    return true;
  }
}

export function writeCommentsVisible(storage: Writer | null | undefined, visible: boolean): boolean {
  try {
    storage?.setItem(COMMENTS_VISIBLE_KEY, visible ? "shown" : "hidden");
    return true;
  } catch {
    return false;
  }
}

export type CommentStorage = Reader & Writer;

export function browserCommentStorage(): CommentStorage | null {
  try {
    return (globalThis as { localStorage?: CommentStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}

export const openThreadCount = (threads: { resolvedAt: string | null }[]): number =>
  threads.filter((thread) => thread.resolvedAt === null).length;

export const visibleThreads = <T extends { resolvedAt: string | null }>(threads: T[], showResolved: boolean): T[] =>
  showResolved ? threads : threads.filter((thread) => thread.resolvedAt === null);
