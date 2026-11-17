import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string): string => {
  const file = new URL(path, import.meta.url);
  assert.ok(existsSync(file), `missing ${path}: T3 has not created it yet`);
  return readFileSync(file, "utf8");
};
const RESET = "../apps/dashboard/src/ResetPage.tsx";
const MAIN = "../apps/dashboard/src/main.tsx";
const CLIENT = "../apps/dashboard/src/auth-client.ts";
const SCREEN = "../apps/dashboard/src/AuthScreen.tsx";

test("the reset page is routed from /reset-password and its fragment, before the 404 fallback", () => {
  const main = read(MAIN);
  assert.match(main, /from "\.\/ResetPage\.tsx"/);
  assert.match(main, /path === "\/reset-password"/);
  assert.match(main, /window\.location\.hash/);
  const reset = main.indexOf("<ResetPage");
  const notFound = main.indexOf("<NotFoundPage />");
  assert.ok(reset > 0, "main.tsx must render <ResetPage />");
  assert.ok(notFound > reset, "the /reset-password branch must precede the NotFoundPage fallback");
  assert.match(main, /path === "\/register"/);
  assert.match(main, /from "\.\/RegisterPage\.tsx"/);
});

test("the reset page reads the fragment token once and previews it before showing the form", () => {
  const page = read(RESET);
  assert.match(page, /window\.location\.hash/);
  assert.match(page, /tokenFromFragment\(/);
  assert.match(page, /previewPasswordReset\(/);
  assert.match(page, /"checking"/);
  assert.match(page, /"ready"/);
  assert.match(page, /"refused"/);
  assert.match(page, /"done"/);
  assert.doesNotMatch(page, /\{43\}/);
  assert.doesNotMatch(page, /\?token=|searchParams\.get\("token"\)/);
  assert.doesNotMatch(page, /localStorage|sessionStorage|document\.cookie|history\.(replace|push)State|console\./);
});

test("the account email is fixed and read-only, and both password fields are masked new-password fields", () => {
  const page = read(RESET);
  assert.match(page, /id="reset-email"/);
  assert.match(page, /\{state\.email\}/);
  assert.doesNotMatch(page, /type="email"|name="email"|htmlFor="reset-email"/);
  assert.doesNotMatch(page, /onChange=\{[^}]*email/);
  assert.doesNotMatch(page, /readOnly/);

  assert.equal((page.match(/type="password"/g) ?? []).length, 2, "password and confirmation are both masked");
  assert.equal((page.match(/autoComplete="new-password"/g) ?? []).length, 2);
  assert.match(page, /htmlFor="reset-password"/);
  assert.match(page, /htmlFor="reset-confirmation"/);

  const check = page.indexOf("resetPasswordError(values.password, values.confirmation)");
  const request = page.indexOf("completePasswordReset(");
  assert.ok(check > 0, "ResetPage must validate the pair with resetPasswordError");
  assert.ok(request > check, "the form validates before it sends anything");
  assert.equal((page.match(/completePasswordReset\(/g) ?? []).length, 1);

  assert.match(page, /password: "", confirmation: ""/);
});

test("a completed reset shows a confirmation with a sign-in link and never signs the person in", () => {
  const page = read(RESET);
  assert.match(page, /href="\/login"/);
  assert.match(page, /role="status"/);
  assert.match(page, /Password (?:updated|changed)/);
  assert.doesNotMatch(page, /signIn\(/, "the person signs in with the new password, never automatically");
  assert.doesNotMatch(page, /signUp\(/, "a reset never creates an account");
  assert.doesNotMatch(page, /window\.location\.assign/, "no navigation away from the confirmation");
});

test("a refused reset link shows one generic message for every reason and stops offering the form", () => {
  const page = read(RESET);
  assert.match(page, /RESET_REFUSED/);
  assert.match(page, /role="alert"/);
  assert.doesNotMatch(page, /INVALID_RESET|PASSWORD_INVALID|"expired"|"already_used"|"replaced"/);
  const refused = page.indexOf('state.kind === "refused"');
  assert.ok(refused > 0, "the refused state has its own render branch");
});

test("the invitation and login surfaces keep their source and the reset client is additive", () => {
  const main = read(MAIN);
  assert.match(main, /<RegisterPage hash=\{window\.location\.hash\} \/>/);

  const screen = read(SCREEN);
  assert.match(screen, /invitation\.email/);
  assert.match(screen, /readOnly/);
  assert.match(screen, /invitation\.submit/);

  const client = read(CLIENT);
  assert.match(client, /export const INVITE_REFUSED/);
  assert.match(client, /export async function previewInvitation\(/);
  assert.match(client, /export async function completeInvitation\(/);
  assert.match(client, /export async function previewPasswordReset\(/);
  assert.match(client, /export async function completePasswordReset\(/);
  assert.equal((client.match(/export function tokenFromFragment\(/g) ?? []).length, 1);
});
