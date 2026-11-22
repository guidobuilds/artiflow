import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
  type Awareness,
} from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import type * as Y from "yjs";

import { editsDocumentInApp } from "@artiflow/domain/kinds";

import type { Database } from "../adapters/postgres/db/client.ts";
import type { AuthInstance } from "../auth.ts";
import { isUuid } from "../http/index.ts";
import { canEdit, documentFor } from "../routes/editing.ts";
import type { Room, RoomConnection, Rooms } from "./rooms.ts";

export const COLLAB_PATH = "/api/collab";
export const COLLAB_CLOSE_UNAUTHORIZED = 4401;
export const COLLAB_CLOSE_FORBIDDEN = 4403;
export const COLLAB_CLOSE_NOT_FOUND = 4404;
export const COLLAB_CLOSE_PROTOCOL = 1002;
export const COLLAB_CLOSE_GOING_AWAY = 1001;

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MAX_QUEUED_MESSAGES = 64;
const CLOSE_TIMEOUT_MS = 1_000;
export const COLLAB_REAUTHORIZE_MS = 30_000;

export type CollabAuthorization = { ok: true; userId: string } | { ok: false; code: number; reason: string };

export type CollabAuthorizer = (input: { headers: Headers; artifactId: string }) => Promise<CollabAuthorization>;

export type CollabAccessRow = { access: string; kind: string };

export function documentAuthorizer(input: {
  sessionUserId: (headers: Headers) => Promise<string | null>;
  documentAccess: (userId: string, artifactId: string) => Promise<CollabAccessRow | null>;
}): CollabAuthorizer {
  return async ({ headers, artifactId }) => {
    const userId = await input.sessionUserId(headers);
    if (userId === null) return { ok: false, code: COLLAB_CLOSE_UNAUTHORIZED, reason: "unauthorized" };
    const row = await input.documentAccess(userId, artifactId);
    if (row === null) return { ok: false, code: COLLAB_CLOSE_NOT_FOUND, reason: "not_found" };
    if (!canEdit(row)) return { ok: false, code: COLLAB_CLOSE_FORBIDDEN, reason: "forbidden" };
    if (!editsDocumentInApp(row.kind)) return { ok: false, code: COLLAB_CLOSE_FORBIDDEN, reason: "not_a_document" };
    return { ok: true, userId };
  };
}

export function createSessionAuthorizer(input: { database: Database; auth: AuthInstance }): CollabAuthorizer {
  return documentAuthorizer({
    sessionUserId: async (headers: Headers): Promise<string | null> => {
      const session = await input.auth.api.getSession({ headers });
      const id = session?.user?.id;
      return typeof id === "string" && id.length > 0 ? id : null;
    },
    documentAccess: async (userId: string, artifactId: string) => {
      const row = await documentFor(input.database.db, userId, artifactId);
      return row === undefined ? null : { access: row.access, kind: row.kind };
    },
  });
}

type UpgradeHost = {
  on: (event: "upgrade", listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void) => unknown;
  off: (event: "upgrade", listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void) => unknown;
};

export type AttachCollabInput = {
  server: UpgradeHost;
  rooms: Rooms;
  authorize: CollabAuthorizer;
  allowedOrigin: string;
  path?: string;
  reauthorizeMs?: number;
};

export type CollabServer = { close: () => Promise<void>; socketCount: () => number };

function headersOf(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
      continue;
    }
    headers.set(name, value);
  }
  return headers;
}

function artifactIdOf(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

function bytesOf(data: RawData): Uint8Array | null {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function send(ws: WebSocket, build: (encoder: encoding.Encoder) => void): void {
  if (ws.readyState !== ws.OPEN) return;
  const encoder = encoding.createEncoder();
  build(encoder);
  ws.send(encoding.toUint8Array(encoder));
}

function connectionFor(ws: WebSocket, userId: string): RoomConnection {
  return {
    userId,
    sendUpdate: (update: Uint8Array): void =>
      send(ws, (encoder) => {
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeUpdate(encoder, update);
      }),
    sendAwareness: (update: Uint8Array): void =>
      send(ws, (encoder) => {
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(encoder, update);
      }),
  };
}

function sendSyncStepOne(ws: WebSocket, doc: Y.Doc): void {
  send(ws, (encoder) => {
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, doc);
  });
}

function sendAwarenessStates(ws: WebSocket, awareness: Awareness): void {
  const clientIds = [...awareness.getStates().keys()];
  if (clientIds.length === 0) return;
  send(ws, (encoder) => {
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, clientIds));
  });
}

async function serveSocket(input: {
  ws: WebSocket;
  artifactId: string;
  headers: Headers;
  rooms: Rooms;
  authorize: CollabAuthorizer;
  reauthorizeMs: number;
}): Promise<void> {
  const { ws, artifactId, rooms, authorize } = input;
  const queued: Uint8Array[] = [];
  let ready = false;
  let closed = false;
  let cleanup: (() => void) | null = null;
  let dispatch: (bytes: Uint8Array) => void = (): void => undefined;

  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (!isBinary) return;
    const bytes = bytesOf(data);
    if (bytes === null) return;
    if (!ready) {
      if (queued.length < MAX_QUEUED_MESSAGES) queued.push(bytes);
      return;
    }
    dispatch(bytes);
  });
  ws.on("close", () => {
    closed = true;
    const pending = cleanup;
    cleanup = null;
    pending?.();
  });
  ws.on("error", () => {
    ws.terminate();
  });

  const authorization = await authorize({ headers: input.headers, artifactId });
  if (closed) return;
  if (!authorization.ok) {
    ws.close(authorization.code, authorization.reason);
    return;
  }

  const connection = connectionFor(ws, authorization.userId);
  const joined = await rooms.join({ artifactId, connection });
  if (!joined.ok) {
    if (!closed) ws.close(COLLAB_CLOSE_NOT_FOUND, joined.reason);
    return;
  }
  const room: Room = joined.room;
  const controlled = new Set<number>();
  const onAwareness = (changed: { added: number[]; updated: number[]; removed: number[] }, origin: unknown): void => {
    if (origin !== connection) return;
    for (const clientId of changed.added) controlled.add(clientId);
    for (const clientId of changed.removed) controlled.delete(clientId);
  };
  room.awareness.on("update", onAwareness);

  const reauthorize = setInterval(() => {
    authorize({ headers: input.headers, artifactId }).then(
      (current) => {
        if (closed) return;
        if (!current.ok) ws.close(current.code, current.reason);
        else if (current.userId !== authorization.userId) ws.close(COLLAB_CLOSE_UNAUTHORIZED, "unauthorized");
      },
      () => undefined,
    );
  }, input.reauthorizeMs);
  reauthorize.unref?.();

  const release = (): void => {
    clearInterval(reauthorize);
    room.awareness.off("update", onAwareness);
    removeAwarenessStates(room.awareness, [...controlled], null);
    void rooms.leave({ room, connection });
  };
  cleanup = release;
  if (closed) {
    cleanup = null;
    release();
    return;
  }

  dispatch = (bytes: Uint8Array): void => {
    const decoder = decoding.createDecoder(bytes);
    const encoder = encoding.createEncoder();
    try {
      const messageType = decoding.readVarUint(decoder);
      if (messageType === MESSAGE_SYNC) {
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, room.doc, connection);
        if (encoding.length(encoder) > 1 && ws.readyState === ws.OPEN) ws.send(encoding.toUint8Array(encoder));
        return;
      }
      if (messageType === MESSAGE_AWARENESS)
        applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), connection);
    } catch {
      ws.close(COLLAB_CLOSE_PROTOCOL, "protocol_error");
    }
  };

  sendSyncStepOne(ws, room.doc);
  sendAwarenessStates(ws, room.awareness);
  ready = true;
  for (const message of queued.splice(0)) dispatch(message);
}

export function attachCollabServer(input: AttachCollabInput): CollabServer {
  const prefix = `${input.path ?? COLLAB_PATH}/`;
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  let closing = false;

  const refuse = (socket: Duplex, status: string): void => {
    socket.write(`HTTP/1.1 ${status}\r\nconnection: close\r\n\r\n`);
    socket.destroy();
  };

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith(prefix)) {
      refuse(socket, "404 Not Found");
      return;
    }
    if (closing) {
      refuse(socket, "503 Service Unavailable");
      return;
    }
    if (request.headers.origin !== input.allowedOrigin) {
      refuse(socket, "403 Forbidden");
      return;
    }
    const artifactId = artifactIdOf(url.pathname.slice(prefix.length));
    if (artifactId === undefined) {
      refuse(socket, "400 Bad Request");
      return;
    }
    if (!isUuid(artifactId)) {
      refuse(socket, "404 Not Found");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.add(ws);
      ws.on("close", () => sockets.delete(ws));
      void serveSocket({
        ws,
        artifactId,
        headers: headersOf(request),
        rooms: input.rooms,
        authorize: input.authorize,
        reauthorizeMs: input.reauthorizeMs ?? COLLAB_REAUTHORIZE_MS,
      });
    });
  };

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    try {
      upgrade(request, socket, head);
    } catch {
      socket.destroy();
    }
  };

  input.server.on("upgrade", onUpgrade);

  return {
    socketCount: (): number => sockets.size,
    close: async (): Promise<void> => {
      closing = true;
      input.server.off("upgrade", onUpgrade);
      const open = [...sockets];
      if (open.length > 0) {
        await new Promise<void>((resolve) => {
          let remaining = open.length;
          const done = (): void => {
            remaining -= 1;
            if (remaining <= 0) resolve();
          };
          const timer = setTimeout(() => {
            for (const ws of open) ws.terminate();
            resolve();
          }, CLOSE_TIMEOUT_MS);
          timer.unref?.();
          for (const ws of open) {
            ws.once("close", done);
            ws.close(COLLAB_CLOSE_GOING_AWAY, "server_shutting_down");
          }
        });
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
