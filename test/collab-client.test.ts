import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import OriginWebSocket from "ws";

import { MARKDOWN_DOC_FIELD, readMarkdownFromFragment } from "@artiflow/domain/markdown-doc";
import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import { createRooms } from "../apps/api/src/collab/rooms.ts";
import { attachCollabServer, COLLAB_CLOSE_FORBIDDEN, type CollabAuthorizer } from "../apps/api/src/collab/socket.ts";
import type { ArtifactDocumentState, DocumentStore, DraftRecord } from "../apps/api/src/domain/documents/service.ts";
import {
  COLLAB_UNAVAILABLE_MESSAGE,
  collabBaseUrl,
  collabSocketUrl,
  openCollabSession,
  presenceColor,
  presenceCursor,
  presenceFor,
  type CollabOutcome,
  type CollabSession,
} from "../apps/dashboard/src/collab.ts";

const ARTIFACT = "0f8f1f0a-1f4b-4c4a-9d5e-0a1b2c3d4e5f";
const OTHER_ARTIFACT = "7c2d1b3a-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
const DRAFT_TEXT = "# Notes\n\nshared by the room";

type Harness = {
  artifactId: string;
  origin: string;
  upgrades: number;
  close: () => Promise<void>;
};

function stubStorage(): Storage {
  const unused = (): never => {
    throw new Error("the client tests never touch stored bytes");
  };
  return {
    client: { send: unused } as unknown as Storage["client"],
    bucket: "test-bucket",
    checkBucket: async (): Promise<void> => undefined,
    destroy: (): void => undefined,
  };
}

function seededStore(artifactId: string): DocumentStore {
  const drafts = new Map<string, DraftRecord>([
    [
      artifactId,
      {
        artifactId,
        seq: 0,
        formatVersion: 1,
        state: { formatVersion: 1, text: DRAFT_TEXT },
        updatedByUserId: null,
        updatedAt: new Date("2026-11-22T09:00:00.000Z"),
      },
    ],
  ]);
  const unused = async (): Promise<never> => {
    throw new Error("unused store method");
  };
  return {
    readArtifact: async (id: string): Promise<ArtifactDocumentState | null> =>
      id === artifactId
        ? {
            artifactId,
            kind: "markdown",
            publishedSeq: 0,
            currentRevisionId: null,
            revisionCount: 0,
            latestSnapshot: null,
          }
        : null,
    readDraft: async (id: string): Promise<DraftRecord | null> => drafts.get(id) ?? null,
    insertDraftIfAbsent: unused,
    readOperation: unused,
    readSnapshotAtOrBefore: unused,
    readAppliedOperations: unused,
    commitOperation: unused,
    commitSnapshot: unused,
  } as unknown as DocumentStore;
}

async function startHarness(authorize: CollabAuthorizer): Promise<Harness> {
  const rooms = createRooms({
    store: seededStore(ARTIFACT),
    storage: stubStorage(),
    debounceMs: 50,
    log: (): void => undefined,
  });
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  let upgrades = 0;
  server.on("upgrade", () => {
    upgrades += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const collab = attachCollabServer({ server, rooms, authorize, allowedOrigin: origin });
  return {
    artifactId: ARTIFACT,
    origin,
    get upgrades(): number {
      return upgrades;
    },
    close: async (): Promise<void> => {
      await collab.close();
      await rooms.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const allowEveryone: CollabAuthorizer = async () => ({ ok: true, userId: "person-1" });
const refuseEveryone: CollabAuthorizer = async () => ({
  ok: false,
  code: COLLAB_CLOSE_FORBIDDEN,
  reason: "forbidden",
});

function socketPolyfill(): typeof OriginWebSocket {
  return class extends OriginWebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, { origin: new URL(address).origin.replace(/^ws/, "http") });
    }
  } as unknown as typeof OriginWebSocket;
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

const open = (harness: Harness, user: { id: string; name: string }, artifactId = harness.artifactId) =>
  openCollabSession({
    artifactId,
    origin: harness.origin,
    user,
    websocket: socketPolyfill(),
    timeoutMs: 3000,
  });

const live = (outcome: CollabOutcome): CollabSession => {
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.fallback.message);
  if (!outcome.ok) throw new Error("unreachable");
  return outcome.session;
};

test("the provider builds the document socket url from the origin and refuses a non-uuid artifact", () => {
  assert.equal(collabBaseUrl("https://artiflow.test"), "wss://artiflow.test/api/collab");
  assert.equal(collabBaseUrl("http://127.0.0.1:5173"), "ws://127.0.0.1:5173/api/collab");
  assert.equal(
    collabSocketUrl("https://artiflow.test", ARTIFACT),
    `wss://artiflow.test/api/collab/${ARTIFACT}`,
    "the same-origin socket carries the session cookie under /api/collab/<artifactId>",
  );
  assert.equal(
    collabSocketUrl("http://127.0.0.1:5173/", OTHER_ARTIFACT),
    `ws://127.0.0.1:5173/api/collab/${OTHER_ARTIFACT}`,
  );
  for (const refused of ["a1", "not-a-uuid", ARTIFACT.toUpperCase(), `${ARTIFACT}-x`])
    assert.throws(() => collabSocketUrl("https://artiflow.test", refused), /uuid artifact id/);
});

test("presence colours are deterministic per user id and differ between users", () => {
  const ada = presenceFor({ id: "user-1", name: "Ada" });
  assert.deepEqual(ada, { id: "user-1", name: "Ada", color: presenceColor("user-1") });
  assert.equal(presenceFor({ id: "user-1", name: "Ada" }).color, ada.color, "the same id keeps its colour");
  for (const id of ["user-2", "user-3", "user-4", "user-5"])
    assert.notEqual(presenceColor(id), ada.color, `user ${id} must be distinguishable from user-1`);
  assert.equal(presenceFor({ id: "user-1", name: "  " }).name, "Someone");
});

test("the cursor markup carries the participant colour and name", () => {
  const user = presenceFor({ id: "user-7", name: "Grace Hopper" });
  const cursor = presenceCursor(user);
  assert.equal(cursor.className, "collaboration-carets__caret");
  assert.equal(cursor.style.borderLeft, `2px solid ${user.color}`);
  const label = cursor.children[0];
  assert.ok(label);
  assert.equal(label.className, "collaboration-carets__label");
  assert.equal(label.text, "Grace Hopper", "the caret label is the name, never an id");
  assert.equal(label.style.backgroundColor, user.color);
});

test("a socket that synces becomes the collaboration binding with the room text and awareness user", async () => {
  const harness = await startHarness(allowEveryone);
  const outcome = await open(harness, { id: "user-1", name: "Ada" });
  try {
    const session = live(outcome);
    assert.equal(session.url, `${harness.origin.replace("http", "ws")}/api/collab/${ARTIFACT}`);
    assert.equal(
      readMarkdownFromFragment(session.doc.getXmlFragment(MARKDOWN_DOC_FIELD)),
      DRAFT_TEXT,
      "the room's draft arrives as the collaboration document",
    );
    assert.deepEqual(session.awareness.getLocalState()?.user, presenceFor({ id: "user-1", name: "Ada" }));
    assert.equal(harness.upgrades, 1);
    session.destroy();
  } finally {
    await harness.close();
  }
});

test("two participants in one room see each other's awareness with different colours", async () => {
  const harness = await startHarness(allowEveryone);
  const first = live(await open(harness, { id: "user-1", name: "Ada" }));
  const second = live(await open(harness, { id: "user-2", name: "Grace" }));
  const usersIn = (session: CollabSession): { id?: unknown; name?: unknown; color?: unknown }[] =>
    [...session.awareness.getStates().values()].map(
      (state) => (state.user ?? {}) as { id?: unknown; name?: unknown; color?: unknown },
    );
  try {
    await waitFor(
      () => usersIn(first).length === 2 && usersIn(second).length === 2,
      "both awareness states to reach both clients",
    );
    const colourOf = (session: CollabSession, id: string): unknown =>
      usersIn(session).find((user) => user.id === id)?.color;
    assert.equal(colourOf(second, "user-1"), presenceColor("user-1"));
    assert.equal(colourOf(first, "user-2"), presenceColor("user-2"));
    assert.notEqual(presenceColor("user-1"), presenceColor("user-2"));
    first.destroy();
    await waitFor(() => usersIn(second).length === 1, "leaving to drop the departed participant");
  } finally {
    second.destroy();
    await harness.close();
  }
});

test("a refused socket lands in the fallback with a message and is never retried", async () => {
  const harness = await startHarness(refuseEveryone);
  try {
    const outcome = await open(harness, { id: "user-1", name: "Ada" });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.fallback.reason, "refused");
    assert.equal(outcome.fallback.code, COLLAB_CLOSE_FORBIDDEN);
    assert.match(outcome.fallback.message, /refused/);
    assert.match(outcome.fallback.message, /forbidden/);
    assert.equal(harness.upgrades, 1, "the policy close is final");
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(harness.upgrades, 1, "a refused socket is not retried in a loop");
  } finally {
    await harness.close();
  }
});

test("a server without the feature falls back quietly instead of hanging the editor", async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const outcome = await openCollabSession({
    artifactId: ARTIFACT,
    origin: `http://127.0.0.1:${port}`,
    user: { id: "user-1", name: "Ada" },
    websocket: socketPolyfill(),
    timeoutMs: 2000,
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.fallback.reason, "unavailable");
  assert.equal(outcome.fallback.message, COLLAB_UNAVAILABLE_MESSAGE);
});

test("an artifact id that is not a uuid never opens a socket", async () => {
  const outcome = await openCollabSession({
    artifactId: "a1",
    origin: "https://artiflow.test",
    user: { id: "user-1", name: "Ada" },
    websocket: socketPolyfill(),
    timeoutMs: 200,
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.fallback.reason, "unavailable");
});

test("the dev proxy upgrades websockets for /api and the Caddyfile serves the same path", () => {
  const vite = readFileSync(new URL("../apps/dashboard/vite.config.ts", import.meta.url), "utf8");
  assert.match(vite, /"\/api": \{ target: apiTarget, ws: true \}/, "vite must proxy the upgrade, not only the request");
  const caddy = readFileSync(new URL("../docker/Caddyfile", import.meta.url), "utf8");
  assert.match(caddy, /@backend path [^\n]*\/api\/\*/);
  assert.match(caddy, /reverse_proxy \{\$API_UPSTREAM::api:8787\}/);
  assert.doesNotMatch(caddy, /handle @backend \{[^}]*websocket/i);
});

test("the editor page binds the collaboration document and caret instead of autosaving when the session is live", () => {
  const page = readFileSync(new URL("../apps/dashboard/src/EditorPage.tsx", import.meta.url), "utf8");
  assert.match(page, /Collaboration\.configure\(\{ document: session\.doc, field: MARKDOWN_DOC_FIELD \}\)/);
  assert.match(page, /CollaborationCaret\.configure\(\{/);
  assert.match(
    page,
    /render: \(user: Record<string, unknown>\) => renderCursorMarkup\(presenceCursor\(presenceOf\(user\)\)\)/,
  );
  assert.match(page, /if \(collab !== null\) setState\(/);
  assert.match(page, /if \(!editor \|\| collab !== null\) return;\n\s*const controller = new Autosave\(/);
  assert.match(page, /if \(collab !== null \|\| !editor\) return;/);
});

test("presence lives in awareness only and joining never rewrites the document", async () => {
  const harness = await startHarness(allowEveryone);
  const session = live(await open(harness, { id: "user-1", name: "Ada" }));
  try {
    assert.deepEqual(
      session.awareness.getLocalState(),
      { user: presenceFor({ id: "user-1", name: "Ada" }) },
      "awareness carries presence and nothing about the document",
    );
    assert.equal(
      readMarkdownFromFragment(session.doc.getXmlFragment(MARKDOWN_DOC_FIELD)),
      DRAFT_TEXT,
      "joining changes no stored text",
    );
  } finally {
    session.destroy();
    await harness.close();
  }
});
