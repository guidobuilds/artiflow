export const AMBIGUOUS_SELECTION =
  "That text appears in more than one place. Select the whole cell, or a longer phrase, to comment on one spot.";

type DraftAnchor = { anchor: unknown; candidates: readonly unknown[] };

export const draftBlockedReason = (draft: DraftAnchor | null): string | null =>
  draft === null || draft.anchor !== null ? null : AMBIGUOUS_SELECTION;
