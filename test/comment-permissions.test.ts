import assert from "node:assert/strict";
import { test } from "node:test";

import { artifactPermissions, type ArtifactAccess } from "@artiflow/domain/comment-permissions";

test("each access level carries one decided permission set", () => {
  assert.deepEqual(artifactPermissions("owner"), { comment: true, resolve: true, deleteAny: true, manage: true });
  assert.deepEqual(artifactPermissions("editor"), { comment: true, resolve: true, deleteAny: false, manage: false });
  assert.deepEqual(artifactPermissions("commenter"), { comment: true, resolve: true, deleteAny: false, manage: false });
  assert.deepEqual(artifactPermissions("reader"), { comment: false, resolve: false, deleteAny: false, manage: false });
});

test("only the owner may delete another author's thread and manage the artifact", () => {
  const access: ArtifactAccess[] = ["owner", "editor", "commenter", "reader"];
  assert.deepEqual(access.filter((level) => artifactPermissions(level).deleteAny), ["owner"]);
  assert.deepEqual(access.filter((level) => artifactPermissions(level).manage), ["owner"]);
  assert.deepEqual(access.filter((level) => artifactPermissions(level).comment), ["owner", "editor", "commenter"]);
});

test("an unknown or missing access is denied, never granted", () => {
  const denied = JSON.stringify({ comment: false, resolve: false, deleteAny: false, manage: false });
  for (const access of [undefined, "", "Owner", "admin", "owner ", "editorial"])
    assert.equal(JSON.stringify(artifactPermissions(access)), denied, String(access));
});
