import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import { AVATAR_PATHS, DEFAULT_AVATAR, avatarSource, initialsOf, randomAvatar } from "../packages/domain/src/avatars.ts";

test("every bundled avatar exists in the dashboard public folder", () => {
  assert.equal(AVATAR_PATHS.length, 4);
  for (const path of AVATAR_PATHS)
    assert.equal(existsSync(new URL(`../apps/dashboard/public${path}`, import.meta.url)), true, path);
});

test("random assignment covers every avatar and stays in range", () => {
  assert.equal(
    randomAvatar(() => 0),
    AVATAR_PATHS[0],
  );
  assert.equal(
    randomAvatar(() => 0.999999),
    AVATAR_PATHS.at(-1),
  );
  assert.equal(
    randomAvatar(() => 1),
    AVATAR_PATHS.at(-1),
  );
  assert.deepEqual(new Set(AVATAR_PATHS.map((_, i) => randomAvatar(() => i / AVATAR_PATHS.length))).size, 4);
});

test("a missing, external or unsafe image falls back to the default avatar", () => {
  assert.equal(avatarSource(null), DEFAULT_AVATAR);
  assert.equal(avatarSource(undefined), DEFAULT_AVATAR);
  assert.equal(avatarSource(""), DEFAULT_AVATAR);
  assert.equal(avatarSource("javascript:alert(1)"), DEFAULT_AVATAR);
  assert.equal(avatarSource("http://host/a.png"), DEFAULT_AVATAR);
  assert.equal(avatarSource("/avatars/avatar-3.png"), "/avatars/avatar-3.png");
  assert.equal(avatarSource("https://host/a.png"), DEFAULT_AVATAR);
});

test("new users get a random avatar unless one is already provided", async () => {
  const { readFileSync } = await import("node:fs");
  const auth = readFileSync(new URL("../apps/api/src/auth.ts", import.meta.url), "utf8");
  assert.match(auth, /databaseHooks:[\s\S]*image: user\.image \?\? randomAvatar\(\)/);
});

test("initials come from the first letters of up to two words", () => {
  assert.equal(initialsOf("Ada Lovelace"), "AL");
  assert.equal(initialsOf("maría josé paz"), "MJ");
  assert.equal(initialsOf("guido"), "G");
  assert.equal(initialsOf("  Ada   Lovelace  "), "AL");
  assert.equal(initialsOf(""), "?");
  assert.equal(initialsOf(null), "?");
  assert.equal(initialsOf(undefined), "?");
});
