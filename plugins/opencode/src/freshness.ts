import { artifactMetadataSchema, type ArtifactMetadata } from "@artiflow/contracts/artifacts";
import * as freshness from "@artiflow/domain/freshness";
import {
  createArtifactPoller,
  type PollerHandle,
  type PollerScheduler,
  type PollerTransport,
  type PollerVisibility,
} from "@artiflow/sdk/poll";

export type ArtifactMetadataRead = (artifactId: string, signal: AbortSignal) => Promise<unknown>;

export type ArtifactTransportOptions = {
  artifactId: string;
  metadata: ArtifactMetadataRead;
  signal: AbortSignal;
};

export function createArtifactTransport(options: ArtifactTransportOptions): PollerTransport<null> {
  let observed: { revisionId: string; sha256: string } | null = null;
  return {
    async getMetadata() {
      const metadata = artifactMetadataSchema.parse(await options.metadata(options.artifactId, options.signal));
      if (metadata.artifactId !== options.artifactId)
        throw new Error(`Artiflow metadata for ${metadata.artifactId}, expected ${options.artifactId}`);
      observed = { revisionId: metadata.revisionId, sha256: metadata.sha256 };
      return metadata;
    },
    async getContent(query) {
      if (observed?.revisionId !== query.revisionId)
        throw new Error("Artiflow freshness content read without matching metadata");
      return { sha256: observed.sha256, content: null };
    },
  };
}

export type ArtifactWatcherOptions = {
  artifactId: string;
  metadata: ArtifactMetadataRead;
  reload: () => void;
  visibility?: PollerVisibility;
  scheduler?: PollerScheduler;
  onError?: (error: unknown) => void;
};

export type ArtifactWatcher = {
  start(): void;
  stop(): void;
};

export function createArtifactWatcher(options: ArtifactWatcherOptions): ArtifactWatcher {
  let running = false;
  let generation = 0;
  let abort: AbortController | null = null;
  let poller: PollerHandle<null> | null = null;

  const release = () => {
    poller?.stop();
    poller = null;
    abort?.abort();
    abort = null;
  };

  const poll = (signal: AbortSignal, reference: ArtifactMetadata | null): PollerHandle<null> => {
    const handle = createArtifactPoller<null>({
      transport: createArtifactTransport({ artifactId: options.artifactId, metadata: options.metadata, signal }),
      target: { artifactId: options.artifactId },
      followLatest: true,
      freshness,
      initialReference: reference,
      visibility: options.visibility,
      scheduler: options.scheduler,
    });
    handle.subscribe((update) => {
      if (update.kind === "content") {
        options.reload();
        handle.markApplied(update.metadata);
        return;
      }
      if (update.kind === "error") options.onError?.(update.error);
    });
    return handle;
  };

  const arm = async (current: number) => {
    release();
    const controller = new AbortController();
    abort = controller;
    let reference: ArtifactMetadata | null = null;
    try {
      reference = await createArtifactTransport({
        artifactId: options.artifactId,
        metadata: options.metadata,
        signal: controller.signal,
      }).getMetadata({ artifactId: options.artifactId });
    } catch (error) {
      if (running && current === generation) options.onError?.(error);
    }
    if (!running || current !== generation) return;
    poller = poll(controller.signal, reference);
    poller.start();
  };

  return {
    start() {
      running = true;
      void arm((generation += 1));
    },
    stop() {
      running = false;
      generation += 1;
      release();
    },
  };
}
