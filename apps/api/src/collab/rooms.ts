import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";

import type { Storage } from "../adapters/storage/client.ts";
import { onOperationsApplied, openDraft, type DocumentStore } from "../domain/documents/service.ts";
import { flushDocumentText, type FlushBase, type FlushOutcome } from "./flush.ts";

export const COLLAB_DEBOUNCE_MS = 1_500;
export const COLLAB_MARKDOWN_FIELD = "markdown";

const LOAD_ORIGIN = "collab:load";
const INVALIDATE_ORIGIN = "collab:invalidate";

export type RoomConnection = {
  readonly userId: string;
  sendUpdate(update: Uint8Array): void;
  sendAwareness(update: Uint8Array): void;
};

export type Room = {
  artifactId: string;
  doc: Y.Doc;
  awareness: Awareness;
  clients: Set<RoomConnection>;
  lastFlushed: FlushBase;
  authorId: string;
  timer: ReturnType<typeof setTimeout> | null;
  flushing: Promise<unknown>;
  closing: boolean;
};

export type RoomJoin = { ok: true; room: Room } | { ok: false; reason: string };

export type Rooms = {
  join(input: { artifactId: string; connection: RoomConnection }): Promise<RoomJoin>;
  leave(input: { room: Room; connection: RoomConnection }): Promise<void>;
  invalidate(artifactId: string): Promise<void>;
  room(artifactId: string): Room | undefined;
  size(): number;
  closeAll(): Promise<void>;
};

export type RoomsInput = {
  store: DocumentStore;
  storage: Storage;
  debounceMs?: number;
  log?: (line: string) => void;
  now?: () => Date;
};

export function createRooms(input: RoomsInput): Rooms {
  const { store, storage } = input;
  const rooms = new Map<string, Room>();
  const opening = new Map<string, Promise<RoomJoin>>();
  const debounceMs = input.debounceMs ?? COLLAB_DEBOUNCE_MS;
  const log = input.log ?? ((line: string): void => console.error(line));
  const now = input.now ?? ((): Date => new Date());

  const markdownOf = (room: Room): string => room.doc.getText(COLLAB_MARKDOWN_FIELD).toString();

  function writeText(room: Room, next: string, origin: string): void {
    const text = room.doc.getText(COLLAB_MARKDOWN_FIELD);
    const current = text.toString();
    if (current === next) return;
    const limit = Math.min(current.length, next.length);
    let prefix = 0;
    while (prefix < limit && current[prefix] === next[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < limit - prefix && current[current.length - 1 - suffix] === next[next.length - 1 - suffix])
      suffix += 1;
    room.doc.transact(() => {
      const removed = current.length - prefix - suffix;
      if (removed > 0) text.delete(prefix, removed);
      const inserted = next.slice(prefix, next.length - suffix);
      if (inserted.length > 0) text.insert(prefix, inserted);
    }, origin);
  }

  function schedule(room: Room): void {
    if (room.timer !== null) clearTimeout(room.timer);
    room.timer = setTimeout(() => {
      room.timer = null;
      void flush(room);
    }, debounceMs);
    room.timer.unref?.();
  }

  function open(artifactId: string, userId: string): Promise<RoomJoin> {
    return openDraft({ store, storage, artifactId, now: now() }).then((opened) => {
      if (!opened.ok) return { ok: false as const, reason: opened.reason };
      const doc = new Y.Doc();
      const room: Room = {
        artifactId,
        doc,
        awareness: new Awareness(doc),
        clients: new Set(),
        lastFlushed: { text: opened.value.text, seq: opened.value.seq },
        authorId: userId,
        timer: null,
        flushing: Promise.resolve(),
        closing: false,
      };
      doc.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin === LOAD_ORIGIN || origin === INVALIDATE_ORIGIN) {
          for (const connection of room.clients) connection.sendUpdate(update);
          return;
        }
        if (typeof origin === "object" && origin !== null && room.clients.has(origin as RoomConnection)) {
          room.authorId = (origin as RoomConnection).userId;
          for (const connection of room.clients) {
            if (connection !== origin) connection.sendUpdate(update);
          }
          schedule(room);
          return;
        }
        room.clients.forEach((connection) => connection.sendUpdate(update));
        schedule(room);
      });
      room.awareness.on(
        "update",
        (changed: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
          const clientIds = [...changed.added, ...changed.updated, ...changed.removed];
          if (clientIds.length === 0) return;
          const encoded = encodeAwarenessUpdate(room.awareness, clientIds);
          for (const connection of room.clients) {
            if (connection !== origin) connection.sendAwareness(encoded);
          }
        },
      );
      if (opened.value.text.length > 0) {
        doc.transact(() => doc.getText(COLLAB_MARKDOWN_FIELD).insert(0, opened.value.text), LOAD_ORIGIN);
      }
      rooms.set(artifactId, room);
      return { ok: true as const, room };
    });
  }

  function attach(room: Room, connection: RoomConnection): RoomJoin {
    room.closing = false;
    room.authorId = connection.userId;
    room.clients.add(connection);
    return { ok: true, room };
  }

  async function join(joinInput: { artifactId: string; connection: RoomConnection }): Promise<RoomJoin> {
    const existing = rooms.get(joinInput.artifactId);
    if (existing !== undefined) return attach(existing, joinInput.connection);
    const inFlight = opening.get(joinInput.artifactId);
    if (inFlight !== undefined) {
      const created = await inFlight;
      return created.ok ? attach(created.room, joinInput.connection) : created;
    }
    const creating = open(joinInput.artifactId, joinInput.connection.userId).finally(() => {
      opening.delete(joinInput.artifactId);
    });
    opening.set(joinInput.artifactId, creating);
    const created = await creating;
    return created.ok ? attach(created.room, joinInput.connection) : created;
  }

  function flush(room: Room): Promise<FlushOutcome> {
    const run = async (): Promise<FlushOutcome> => {
      try {
        const text = markdownOf(room);
        const outcome = await flushDocumentText({
          store,
          storage,
          artifactId: room.artifactId,
          authorId: room.authorId,
          text,
          base: room.lastFlushed,
          now: now(),
        });
        if (outcome.status === "applied") room.lastFlushed = { text: outcome.text, seq: outcome.seq };
        if (outcome.status === "failed")
          log(`[collab] flush of ${room.artifactId} failed: ${outcome.reason} after ${outcome.attempts} attempt(s)`);
        return outcome;
      } catch (error) {
        log(`[collab] flush of ${room.artifactId} threw: ${error instanceof Error ? error.name : "unknown error"}`);
        return { status: "failed", reason: "flush_threw", attempts: 0 };
      }
    };
    const next = room.flushing.then(run, run);
    room.flushing = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function leave(leaveInput: { room: Room; connection: RoomConnection }): Promise<void> {
    const { room, connection } = leaveInput;
    if (rooms.get(room.artifactId) !== room) return;
    room.clients.delete(connection);
    if (room.clients.size > 0) return;
    if (room.timer !== null) {
      clearTimeout(room.timer);
      room.timer = null;
    }
    room.closing = true;
    await flush(room);
    if (room.clients.size > 0) {
      room.closing = false;
      return;
    }
    if (rooms.get(room.artifactId) === room) rooms.delete(room.artifactId);
    room.closing = false;
    room.doc.destroy();
  }

  async function invalidate(artifactId: string): Promise<void> {
    try {
      const room = rooms.get(artifactId);
      if (room === undefined) return;
      if (markdownOf(room) !== room.lastFlushed.text) await flush(room);
      const opened = await openDraft({ store, storage, artifactId, now: now() });
      if (!opened.ok) {
        log(`[collab] cannot invalidate ${artifactId}: ${opened.reason}`);
        return;
      }
      const current = rooms.get(artifactId);
      if (current !== room) return;
      room.lastFlushed = { text: opened.value.text, seq: opened.value.seq };
      writeText(room, opened.value.text, INVALIDATE_ORIGIN);
    } catch (error) {
      log(`[collab] invalidation of ${artifactId} threw: ${error instanceof Error ? error.name : "unknown error"}`);
    }
  }

  async function closeAll(): Promise<void> {
    const open = [...rooms.values()];
    for (const room of open) {
      if (room.timer !== null) {
        clearTimeout(room.timer);
        room.timer = null;
      }
    }
    for (const room of open) {
      await room.flushing.then(
        () => undefined,
        () => undefined,
      );
      await flush(room);
    }
    for (const room of open) {
      if (rooms.get(room.artifactId) !== room) continue;
      rooms.delete(room.artifactId);
      room.clients.clear();
      room.doc.destroy();
    }
  }

  return {
    join,
    leave,
    invalidate,
    room: (artifactId: string): Room | undefined => rooms.get(artifactId),
    size: (): number => rooms.size,
    closeAll,
  };
}

export function attachRoomsToDocumentWrites(rooms: Rooms): () => void {
  return onOperationsApplied((event) => {
    void rooms.invalidate(event.artifactId);
  });
}
