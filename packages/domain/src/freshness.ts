export type MetadataIdentity = {
  revisionId: string;
  revisionNumber: number;
  sha256: string;
};

export type MetadataOrder = "same" | "newer" | "older" | "divergent";

export function compareMetadata(observed: MetadataIdentity, reference: MetadataIdentity): MetadataOrder {
  if (observed.revisionNumber === reference.revisionNumber) {
    return observed.sha256 === reference.sha256 ? "same" : "divergent";
  }
  return observed.revisionNumber > reference.revisionNumber ? "newer" : "older";
}

export type FetchToken = {
  generation: number;
  target: MetadataIdentity;
};

export type FreshnessState = {
  reference: MetadataIdentity | null;
  pending: MetadataIdentity | null;
  inFlight: FetchToken | null;
  generation: number;
  stopped: boolean;
};

export function initialFreshnessState(reference: MetadataIdentity | null = null): FreshnessState {
  return { reference, pending: null, inFlight: null, generation: 0, stopped: false };
}

const identityOf = (metadata: MetadataIdentity): MetadataIdentity => ({
  revisionId: metadata.revisionId,
  revisionNumber: metadata.revisionNumber,
  sha256: metadata.sha256,
});

const isSameIdentity = (left: MetadataIdentity, right: MetadataIdentity): boolean =>
  left.revisionId === right.revisionId && left.revisionNumber === right.revisionNumber && left.sha256 === right.sha256;

const keepPendingAhead = (
  pending: MetadataIdentity | null,
  reference: MetadataIdentity,
): MetadataIdentity | null =>
  pending === null || pending.revisionNumber <= reference.revisionNumber ? null : pending;

const moveReference = (state: FreshnessState, applied: MetadataIdentity): FreshnessState => {
  const reference = identityOf(applied);
  return { ...state, reference, pending: keepPendingAhead(state.pending, reference) };
};

export type AdvanceOutcome = "noop" | "same-bytes" | "reload" | "queued" | "older" | "divergent";

export type AdvanceResult = {
  state: FreshnessState;
  outcome: AdvanceOutcome;
};

export function advanceReference(state: FreshnessState, observed: MetadataIdentity): AdvanceResult {
  const reference = state.reference;
  if (reference === null) {
    return { state: { ...state, reference: identityOf(observed) }, outcome: "noop" };
  }
  switch (compareMetadata(observed, reference)) {
    case "divergent":
      return { state, outcome: "divergent" };
    case "older":
      return { state, outcome: "older" };
    case "same":
      return isSameIdentity(reference, observed)
        ? { state, outcome: "noop" }
        : { state: moveReference(state, observed), outcome: "noop" };
    case "newer":
      break;
  }
  if (observed.sha256 === reference.sha256) {
    return { state: moveReference(state, observed), outcome: "same-bytes" };
  }
  const queued = state.pending;
  if (queued === null) {
    return { state: { ...state, pending: identityOf(observed) }, outcome: "reload" };
  }
  switch (compareMetadata(queued, observed)) {
    case "divergent":
      return { state, outcome: "divergent" };
    case "same":
    case "newer":
      return { state, outcome: "queued" };
    case "older":
      return { state: { ...state, pending: identityOf(observed) }, outcome: "reload" };
  }
}

export type ApplyOutcome = "applied" | "noop" | "older" | "divergent";

export type ApplyResult = {
  state: FreshnessState;
  outcome: ApplyOutcome;
};

export function applyReference(state: FreshnessState, applied: MetadataIdentity): ApplyResult {
  const reference = state.reference;
  if (reference === null) return { state: moveReference(state, applied), outcome: "applied" };
  const order = compareMetadata(applied, reference);
  if (order === "older" || order === "divergent") return { state, outcome: order };
  if (order === "same" && isSameIdentity(reference, applied)) return { state, outcome: "noop" };
  return { state: moveReference(state, applied), outcome: order === "same" ? "noop" : "applied" };
}

export type BeginFetchResult =
  | { ok: true; state: FreshnessState; token: FetchToken }
  | { ok: false; reason: "in-flight" | "stopped"; state: FreshnessState };

export function beginFetch(state: FreshnessState, target: MetadataIdentity): BeginFetchResult {
  if (state.stopped) return { ok: false, reason: "stopped", state };
  if (state.inFlight !== null) return { ok: false, reason: "in-flight", state };
  const generation = state.generation + 1;
  const token: FetchToken = { generation, target: identityOf(target) };
  return { ok: true, state: { ...state, generation, inFlight: token }, token };
}

export type FetchOutcome = { ok: true; sha256: string } | { ok: false; reason?: string };

export type FetchResolution = {
  state: FreshnessState;
  outcome: "discarded" | "retry" | "same-bytes" | "reload" | "unchanged";
};

export function resolveFetch(state: FreshnessState, token: FetchToken, result: FetchOutcome): FetchResolution {
  if (state.stopped || state.inFlight !== token || state.generation !== token.generation) {
    return { outcome: "discarded", state };
  }
  const cleared: FreshnessState = { ...state, inFlight: null };
  if (!result.ok) return { outcome: "retry", state: cleared };
  const resolved: MetadataIdentity = { ...identityOf(token.target), sha256: result.sha256 };
  const advanced = advanceReference(cleared, resolved);
  switch (advanced.outcome) {
    case "same-bytes":
      return { outcome: "same-bytes", state: advanced.state };
    case "reload":
    case "queued":
      return { outcome: "reload", state: advanced.state };
    default:
      return { outcome: "unchanged", state: advanced.state };
  }
}

export type DirtyResolution = "keep-local" | "accept-remote";

export type DirtyDecision = {
  state: FreshnessState;
  intent: "apply" | "keep" | "idle";
};

export function decideAfterDirtyResolution(
  state: FreshnessState,
  resolution: DirtyResolution,
): DirtyDecision {
  if (state.pending === null) return { state, intent: "idle" };
  return { state, intent: resolution === "accept-remote" ? "apply" : "keep" };
}

export function stopFreshness(state: FreshnessState): FreshnessState {
  return { ...state, stopped: true, inFlight: null, generation: state.generation + 1 };
}
