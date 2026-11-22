import type { ArtifactMetadata } from "@artiflow/contracts/artifacts";

export type PolledMetadata = {
  revisionId: string;
  revisionNumber: number;
  sha256: string;
};

export type PollerFetchToken = {
  generation: number;
  target: PolledMetadata;
};

export type PollerFreshnessState = {
  reference: PolledMetadata | null;
  pending: PolledMetadata | null;
  inFlight: PollerFetchToken | null;
  generation: number;
  stopped: boolean;
};

export type PollerAdvanceOutcome = "noop" | "same-bytes" | "reload" | "queued" | "older" | "divergent";

export type PollerAdvanceResult = {
  state: PollerFreshnessState;
  outcome: PollerAdvanceOutcome;
};

export type PollerApplyOutcome = "applied" | "noop" | "older" | "divergent";

export type PollerApplyResult = {
  state: PollerFreshnessState;
  outcome: PollerApplyOutcome;
};

export type PollerFetchOutcome = { ok: true; sha256: string } | { ok: false; reason?: string };

export type PollerFetchResolution = {
  state: PollerFreshnessState;
  outcome: "discarded" | "retry" | "same-bytes" | "reload" | "unchanged";
};

export type PollerBeginFetchResult =
  | { ok: true; state: PollerFreshnessState; token: PollerFetchToken }
  | { ok: false; reason: "in-flight" | "stopped"; state: PollerFreshnessState };

export type PollerFreshness = {
  initialFreshnessState(reference?: PolledMetadata | null): PollerFreshnessState;
  advanceReference(state: PollerFreshnessState, observed: PolledMetadata): PollerAdvanceResult;
  applyReference(state: PollerFreshnessState, applied: PolledMetadata): PollerApplyResult;
  beginFetch(state: PollerFreshnessState, target: PolledMetadata): PollerBeginFetchResult;
  resolveFetch(state: PollerFreshnessState, token: PollerFetchToken, result: PollerFetchOutcome): PollerFetchResolution;
  stopFreshness(state: PollerFreshnessState): PollerFreshnessState;
};

export type PollerTarget = {
  artifactId: string;
  revisionId?: string;
};

export type MetadataQuery = { artifactId: string; revisionId?: string };
export type ContentQuery = { artifactId: string; revisionId: string };

export type PolledContent<TContent> = { sha256: string; content: TContent };

export type PollerTransport<TContent> = {
  getMetadata(query: MetadataQuery): Promise<ArtifactMetadata>;
  getContent(query: ContentQuery): Promise<PolledContent<TContent>>;
};

export type PollerUpdate<TContent> =
  | { kind: "metadata"; metadata: ArtifactMetadata }
  | { kind: "content"; metadata: ArtifactMetadata; content: TContent }
  | { kind: "divergent"; metadata: ArtifactMetadata }
  | { kind: "error"; error: unknown };

export type PollerScheduler = {
  schedule(handler: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
};

export type PollerVisibility = {
  hidden(): boolean;
  subscribe(listener: () => void): () => void;
};

export type PollerOptions<TContent> = {
  transport: PollerTransport<TContent>;
  target: PollerTarget;
  freshness: PollerFreshness;
  followLatest?: boolean;
  intervalMs?: number;
  hiddenIntervalMs?: number | null;
  initialReference?: PolledMetadata | null;
  scheduler?: PollerScheduler;
  visibility?: PollerVisibility;
};

export type PollerHandle<TContent> = {
  start(): void;
  stop(): void;
  flush(): void;
  markApplied(metadata: PolledMetadata): void;
  subscribe(listener: (update: PollerUpdate<TContent>) => void): () => void;
  state(): PollerFreshnessState;
};

const DEFAULT_VISIBLE_INTERVAL_MS = 8_000;
const MAX_VISIBLE_INTERVAL_MS = 10_000;

const systemScheduler: PollerScheduler = {
  schedule: (handler, delayMs) => setTimeout(handler, delayMs),
  cancel: (handle) => clearTimeout(handle as number),
};

const alwaysVisible: PollerVisibility = { hidden: () => false, subscribe: () => () => {} };

export function createArtifactPoller<TContent>(options: PollerOptions<TContent>): PollerHandle<TContent> {
  const decisions = options.freshness;
  const scheduler = options.scheduler ?? systemScheduler;
  const visibility = options.visibility ?? alwaysVisible;
  const listeners = new Set<(update: PollerUpdate<TContent>) => void>();
  const visibleInterval = Math.max(
    0,
    Math.min(options.intervalMs ?? DEFAULT_VISIBLE_INTERVAL_MS, MAX_VISIBLE_INTERVAL_MS),
  );
  const hiddenInterval = options.hiddenIntervalMs ?? null;

  let current = decisions.initialFreshnessState(options.initialReference ?? null);
  let timer: unknown = null;
  let running = false;
  let inFlight = false;
  let delivered: { revisionNumber: number; sha256: string } | null = null;
  let releaseVisibility: (() => void) | null = null;

  const query = (): MetadataQuery =>
    options.followLatest === true || options.target.revisionId === undefined
      ? { artifactId: options.target.artifactId }
      : { artifactId: options.target.artifactId, revisionId: options.target.revisionId };

  const emit = (update: PollerUpdate<TContent>) => {
    for (const listener of [...listeners]) listener(update);
  };

  const alreadyDelivered = (pending: PolledMetadata): boolean =>
    delivered !== null && delivered.revisionNumber === pending.revisionNumber && delivered.sha256 === pending.sha256;

  const clearTimer = () => {
    if (timer === null) return;
    scheduler.cancel(timer);
    timer = null;
  };

  const scheduleNext = () => {
    clearTimer();
    if (!running) return;
    const delay = visibility.hidden() ? hiddenInterval : visibleInterval;
    if (delay === null) return;
    timer = scheduler.schedule(() => {
      timer = null;
      void poll();
    }, delay);
  };

  const readContent = async (metadata: ArtifactMetadata): Promise<void> => {
    const pending = current.pending;
    if (pending === null) return;
    if (alreadyDelivered(pending)) return;
    const began = decisions.beginFetch(current, pending);
    if (!began.ok) return;
    current = began.state;

    let fetched: PolledContent<TContent>;
    try {
      fetched = await options.transport.getContent({
        artifactId: options.target.artifactId,
        revisionId: pending.revisionId,
      });
    } catch (error) {
      if (!running) return;
      current = decisions.resolveFetch(current, began.token, { ok: false }).state;
      emit({ kind: "error", error });
      return;
    }
    if (!running) return;

    const resolved = decisions.resolveFetch(current, began.token, { ok: true, sha256: fetched.sha256 });
    current = resolved.state;
    if (resolved.outcome === "same-bytes") {
      emit({ kind: "metadata", metadata });
      return;
    }
    if (resolved.outcome !== "reload") return;
    delivered = { revisionNumber: pending.revisionNumber, sha256: fetched.sha256 };
    emit({ kind: "content", metadata, content: fetched.content });
  };

  const poll = async (): Promise<void> => {
    if (!running || inFlight) return;
    inFlight = true;
    try {
      let metadata: ArtifactMetadata;
      try {
        metadata = await options.transport.getMetadata(query());
      } catch (error) {
        if (running) emit({ kind: "error", error });
        return;
      }
      if (!running) return;

      const decision = decisions.advanceReference(current, metadata);
      current = decision.state;
      switch (decision.outcome) {
        case "divergent":
          emit({ kind: "divergent", metadata });
          return;
        case "same-bytes":
          emit({ kind: "metadata", metadata });
          return;
        case "reload":
        case "queued":
          await readContent(metadata);
          return;
        default:
          return;
      }
    } finally {
      inFlight = false;
      scheduleNext();
    }
  };

  const start = () => {
    if (running) return;
    running = true;
    releaseVisibility = visibility.subscribe(() => {
      if (!running) return;
      if (visibility.hidden()) {
        scheduleNext();
        return;
      }
      clearTimer();
      void poll();
    });
    scheduleNext();
  };

  const stop = () => {
    if (!running) return;
    running = false;
    clearTimer();
    releaseVisibility?.();
    releaseVisibility = null;
    current = decisions.stopFreshness(current);
    listeners.clear();
  };

  const flush = () => {
    if (!running) return;
    clearTimer();
    void poll();
  };

  const markApplied = (metadata: PolledMetadata) => {
    if (!running) return;
    current = decisions.applyReference(current, metadata).state;
  };

  return {
    start,
    stop,
    flush,
    markApplied,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    state: () => current,
  };
}
