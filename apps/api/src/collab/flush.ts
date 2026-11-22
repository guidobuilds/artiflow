import { createHash } from "node:crypto";

import { diffDocumentOperations } from "@artiflow/domain/document-operations";

import type { Storage } from "../adapters/storage/client.ts";
import { applyOperations, freezeIfDue, openDraft, type DocumentStore } from "../domain/documents/service.ts";

export const COLLAB_FLUSH_KEY_PREFIX = "collab-flush";
export const COLLAB_FLUSH_ATTEMPTS = 2;

export type FlushBase = { text: string; seq: number };

export type FlushOutcome =
  | { status: "unchanged"; seq: number }
  | { status: "applied"; seq: number; text: string; frozen: boolean; attempts: number }
  | { status: "failed"; reason: string; attempts: number };

export type FlushTextInput = {
  store: DocumentStore;
  storage: Storage;
  artifactId: string;
  authorId: string;
  text: string;
  base: FlushBase;
  now?: Date;
};

export function collabFlushKey(input: { artifactId: string; baseSeq: number; text: string }): string {
  const digest = createHash("sha256").update(input.text).digest("hex");
  return `${COLLAB_FLUSH_KEY_PREFIX}:${input.artifactId}:${input.baseSeq}:${digest}`;
}

export async function flushDocumentText(input: FlushTextInput): Promise<FlushOutcome> {
  const { store, storage, artifactId, authorId, text } = input;
  let base = input.base;
  for (let attempt = 1; attempt <= COLLAB_FLUSH_ATTEMPTS; attempt += 1) {
    const operations = diffDocumentOperations(base.text, text);
    if (operations.length === 0) return { status: "unchanged", seq: base.seq };
    const applied = await applyOperations({
      store,
      storage,
      artifactId,
      authorKind: "person",
      authorId,
      baseSeq: base.seq,
      idempotencyKey: collabFlushKey({ artifactId, baseSeq: base.seq, text }),
      ops: operations,
      now: input.now,
      notify: false,
    });
    if (applied.ok) {
      const frozen = await freezeIfDue({ store, storage, artifactId, now: input.now });
      return {
        status: "applied",
        seq: applied.value.seq,
        text,
        frozen: frozen.ok && frozen.value.frozen,
        attempts: attempt,
      };
    }
    if (applied.kind !== "concurrent_edit") return { status: "failed", reason: applied.reason, attempts: attempt };
    const reloaded = await openDraft({ store, storage, artifactId, now: input.now });
    if (!reloaded.ok) return { status: "failed", reason: reloaded.reason, attempts: attempt };
    base = { text: reloaded.value.text, seq: reloaded.value.seq };
  }
  return { status: "failed", reason: "sequence_race_lost_twice", attempts: COLLAB_FLUSH_ATTEMPTS };
}
