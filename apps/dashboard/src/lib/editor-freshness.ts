import type { ArtifactKind, ArtifactMetadata } from "@artiflow/contracts/artifacts";
import {
  createArtifactPoller,
  type MetadataQuery,
  type PolledMetadata,
  type PollerHandle,
  type PollerScheduler,
  type PollerTransport,
  type PollerVisibility,
} from "@artiflow/sdk/poll";

export type DetailRevision = { id: string; revisionNumber: number; sha256: string; sizeBytes: number };

export type DetailWire = { id: string; revision: DetailRevision | null };

export type RemoteText = { text: string; metadata: ArtifactMetadata; seq?: number };

export type EditorRevision = { revisionId: string; revisionNumber: number };

export function metadataFromDetail(detail: DetailWire, kind: ArtifactKind): ArtifactMetadata | null {
  const revision = detail.revision;
  if (revision === null) return null;
  return {
    artifactId: detail.id,
    revisionId: revision.id,
    revisionNumber: revision.revisionNumber,
    kind,
    sha256: revision.sha256,
    sizeBytes: revision.sizeBytes,
  };
}

export type RemoteTextSource = {
  document(): Promise<(EditorRevision & { text: string; seq?: number }) | null>;
  detail(): Promise<ArtifactMetadata | null>;
};

export async function loadRemoteText(source: RemoteTextSource): Promise<RemoteText | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const loaded = await source.document();
    if (loaded === null) return null;
    const metadata = await source.detail();
    if (metadata === null) return null;
    if (metadata.revisionId === loaded.revisionId && metadata.revisionNumber === loaded.revisionNumber)
      return { text: loaded.text, metadata, seq: loaded.seq };
  }
  return null;
}

export type EditorFreshnessDeps = {
  artifactId: string;
  kind: ArtifactKind;
  initial: EditorRevision;
  readMetadata: (query: MetadataQuery) => Promise<ArtifactMetadata>;
  readDocument: (artifactId: string) => Promise<RemoteText>;
  isDirty: () => boolean;
  writeRemote: (remote: RemoteText) => void;
  onPending: (pending: ArtifactMetadata | null) => void;
  followLatest?: boolean;
  intervalMs?: number;
  hiddenIntervalMs?: number | null;
  scheduler?: PollerScheduler;
  visibility?: PollerVisibility;
};

export type DirtyOutcome = "idle" | "kept" | "applied" | "failed";

export type EditorFreshness = {
  start(): void;
  stop(): void;
  flush(): void;
  expectedRevisionId(): string;
  resolve(resolution: "keep-local" | "accept-remote"): Promise<DirtyOutcome>;
  adopt(metadata: PolledMetadata): void;
};

export async function createEditorFreshness(deps: EditorFreshnessDeps): Promise<EditorFreshness> {
  const decisions = await import("@artiflow/domain/freshness");

  const transport: PollerTransport<RemoteText> = {
    getMetadata: (query) => deps.readMetadata(query),
    getContent: async (query) => {
      const remote = await deps.readDocument(query.artifactId);
      return { sha256: remote.metadata.sha256, content: remote };
    },
  };

  let initialReference: PolledMetadata;
  const seeded = await deps.readMetadata({ artifactId: deps.artifactId });
  if (seeded.revisionId === deps.initial.revisionId && seeded.revisionNumber === deps.initial.revisionNumber) {
    initialReference = seeded;
  } else {
    const remote = await deps.readDocument(deps.artifactId);
    deps.writeRemote(remote);
    initialReference = remote.metadata;
  }

  const poller: PollerHandle<RemoteText> = createArtifactPoller<RemoteText>({
    transport,
    target: { artifactId: deps.artifactId, revisionId: deps.initial.revisionId },
    followLatest: deps.followLatest === true,
    freshness: decisions,
    initialReference,
    intervalMs: deps.intervalMs,
    hiddenIntervalMs: deps.hiddenIntervalMs ?? null,
    scheduler: deps.scheduler,
    visibility: deps.visibility,
  });

  let pending: ArtifactMetadata | null = null;

  const applyRemote = (remote: RemoteText) => {
    deps.writeRemote(remote);
    poller.markApplied(remote.metadata);
    pending = null;
    deps.onPending(null);
  };

  const offer = (remote: RemoteText) => {
    if (deps.isDirty()) {
      pending = remote.metadata;
      deps.onPending(pending);
      return;
    }
    applyRemote(remote);
  };

  poller.subscribe((update) => {
    if (update.kind === "content") {
      offer(update.content);
      return;
    }
    if (update.kind === "metadata" && pending !== null && poller.state().pending === null) {
      pending = null;
      deps.onPending(null);
    }
  });

  return {
    start: () => poller.start(),
    stop: () => poller.stop(),
    flush: () => poller.flush(),
    expectedRevisionId: () => poller.state().reference?.revisionId ?? deps.initial.revisionId,
    resolve: async (resolution) => {
      const decision = decisions.decideAfterDirtyResolution(poller.state(), resolution);
      if (decision.intent === "idle") return "idle";
      if (decision.intent === "keep") return "kept";
      let remote: RemoteText;
      try {
        remote = await deps.readDocument(deps.artifactId);
      } catch {
        return "failed";
      }
      if (poller.state().stopped) return "failed";
      applyRemote(remote);
      return "applied";
    },
    adopt: (metadata) => {
      poller.markApplied(metadata);
      pending = null;
      deps.onPending(null);
    },
  };
}
