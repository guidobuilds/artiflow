import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { loadViewerComments } from "../apps/api/src/viewer/comments-degrade.ts";
import { attemptMutation, DEFAULT_MUTATION_ERROR } from "../apps/dashboard/src/viewer-mutations.ts";

test("a comment-store failure costs the viewer its comments, not the document", async () => {
  const errors: unknown[] = [];
  const result = await loadViewerComments({
    document: () => Promise.reject(new Error("connections exhausted")),
    list: () => Promise.resolve(["never-read"]),
    onError: (error) => errors.push(error),
  });
  assert.deepEqual(result, { rows: [], canComment: false, deleteAny: false });
  assert.equal(errors.length, 1, "the failure is reported once");
});

test("a failing comment list degrades the same way", async () => {
  const errors: unknown[] = [];
  const result = await loadViewerComments({
    document: () => Promise.resolve({ access: "editor" }),
    list: () => Promise.reject(new Error("statement timeout")),
    onError: (error) => errors.push(error),
  });
  assert.deepEqual(result, { rows: [], canComment: false, deleteAny: false });
  assert.equal(errors.length, 1);
});

test("a healthy store keeps the rows and refuses comment rights to a reader", async () => {
  assert.deepEqual(
    await loadViewerComments({
      document: () => Promise.resolve({ access: "commenter" }),
      list: () => Promise.resolve([{ id: "c1" }]),
      onError: () => undefined,
    }),
    { rows: [{ id: "c1" }], canComment: true, deleteAny: false },
  );
  assert.deepEqual(
    await loadViewerComments({
      document: () => Promise.resolve({ access: "reader" }),
      list: () => Promise.resolve([{ id: "c1" }]),
      onError: () => undefined,
    }),
    { rows: [{ id: "c1" }], canComment: false, deleteAny: false },
  );
});

test("the load decides deletion rights from the same role table as the endpoints", async () => {
  const owner = await loadViewerComments({
    document: () => Promise.resolve({ access: "owner" }),
    list: () => Promise.resolve([{ id: "c1" }]),
    onError: () => undefined,
  });
  assert.deepEqual(owner, { rows: [{ id: "c1" }], canComment: true, deleteAny: true });
  const unknown = await loadViewerComments({
    document: () => Promise.resolve({ access: "admin" }),
    list: () => Promise.resolve([{ id: "c1" }]),
    onError: () => undefined,
  });
  assert.deepEqual(
    unknown,
    { rows: [{ id: "c1" }], canComment: false, deleteAny: false },
    "an unknown role grants nothing",
  );
});

test("an artifact without a shared comment document reads as no comments", async () => {
  assert.deepEqual(
    await loadViewerComments({
      document: () => Promise.resolve(undefined),
      list: () => Promise.resolve([{ id: "never" }]),
      onError: () => undefined,
    }),
    { rows: [], canComment: false, deleteAny: false },
  );
});

test("a failed mutation keeps a message the reader can act on", async () => {
  assert.deepEqual(await attemptMutation(() => Promise.resolve()), { ok: true });
  assert.deepEqual(await attemptMutation(() => Promise.reject(new Error("Could not save the comment (500)."))), {
    ok: false,
    message: "Could not save the comment (500).",
  });
  assert.deepEqual(await attemptMutation(() => Promise.reject(new Error("   "))), {
    ok: false,
    message: DEFAULT_MUTATION_ERROR,
  });
  assert.deepEqual(await attemptMutation(() => Promise.reject("offline")), {
    ok: false,
    message: DEFAULT_MUTATION_ERROR,
  });
});

test("the viewers refuse to report success on a rejected response and keep the draft for a retry", () => {
  const source = readFileSync(new URL("../apps/dashboard/src/viewer-comments.tsx", import.meta.url), "utf8");
  assert.match(source, /if \(!response\.ok\) throw new Error\(`Could not save the comment/);
  assert.match(source, /if \(!response\.ok\) throw new Error\(`Could not delete the comment/);
  assert.match(source, /state\.busy = false;/);
  assert.match(source, /state\.retry = \(\) => mutate\(run, after\);/);
  assert.match(source, /state\.retry = \(\) => mutate\(run\);/);
  assert.equal(
    /onSubmitDraft=\{\(body\) => \{[^}]*state\.draft = null/.test(source),
    false,
    "submitting never clears the draft itself, so a retry keeps the text",
  );
});
