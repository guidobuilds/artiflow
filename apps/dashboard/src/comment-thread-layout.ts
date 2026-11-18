export type ThreadPlacement = {
  id: string;
  anchorTop: number;
  height: number;
  top: number;
};

export type LayoutInput = {
  threads: { id: string; anchorTop: number; height: number }[];
  activeId?: string | null;
  gap?: number;
  minTop?: number;
};

export const DEFAULT_THREAD_GAP = 12;

const order = (a: { id: string; anchorTop: number }, b: { id: string; anchorTop: number }): number =>
  a.anchorTop - b.anchorTop || a.id.localeCompare(b.id);

export function layoutCommentThreads({
  threads,
  activeId = null,
  gap = DEFAULT_THREAD_GAP,
  minTop = 0,
}: LayoutInput): ThreadPlacement[] {
  if (threads.length === 0) return [];
  const sorted = [...threads].sort(order).map((thread) => ({
    id: thread.id,
    anchorTop: thread.anchorTop,
    height: thread.height,
    top: Math.max(minTop, thread.anchorTop),
  }));
  const activeIndex = activeId === null ? -1 : sorted.findIndex((thread) => thread.id === activeId);
  if (activeIndex < 0) {
    for (let index = 1; index < sorted.length; index++) {
      const previous = sorted[index - 1]!;
      const current = sorted[index]!;
      current.top = Math.max(current.anchorTop, previous.top + previous.height + gap);
    }
    return sorted;
  }
  sorted[activeIndex]!.top = Math.max(minTop, sorted[activeIndex]!.anchorTop);
  for (let index = activeIndex + 1; index < sorted.length; index++) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    current.top = Math.max(current.anchorTop, previous.top + previous.height + gap);
  }
  for (let index = activeIndex - 1; index >= 0; index--) {
    const next = sorted[index + 1]!;
    const current = sorted[index]!;
    current.top = Math.min(current.anchorTop, next.top - current.height - gap);
  }
  const firstAbove = sorted[0]!;
  if (activeIndex > 0 && firstAbove.top < minTop) {
    const shift = minTop - firstAbove.top;
    for (let index = 0; index <= activeIndex; index++) sorted[index]!.top += shift;
  }
  return sorted;
}

export const placementOf = (placements: ThreadPlacement[], id: string): ThreadPlacement | undefined =>
  placements.find((placement) => placement.id === id);

export const marginHeight = (placements: ThreadPlacement[], gap = DEFAULT_THREAD_GAP): number =>
  placements.reduce((bottom, placement) => Math.max(bottom, placement.top + placement.height + gap), 0);

export const overlaps = (a: ThreadPlacement, b: ThreadPlacement): boolean =>
  a.top < b.top + b.height && b.top < a.top + a.height;
