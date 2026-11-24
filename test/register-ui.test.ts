import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string): string => {
  const file = new URL(path, import.meta.url);
  assert.ok(existsSync(file), `missing ${path}: T3 has not created it yet`);
  return readFileSync(file, "utf8");
};
const REGISTER = "../apps/dashboard/src/RegisterPage.tsx";
const SCREEN = "../apps/dashboard/src/AuthScreen.tsx";
const ROUTER = "../apps/dashboard/src/router.tsx";
const bothWays = (left: string, right: string): RegExp =>
  new RegExp(`${left}\\s*&&\\s*${right}|${right}\\s*&&\\s*${left}`);

test("the invitation page is routed from /register and its fragment, before the 404 fallback", () => {
  const router = read(ROUTER);
  assert.match(router, /from "\.\/RegisterPage\.tsx"/);
  assert.match(router, /path: "\/register"/);
  assert.match(router, /hash=\{fragmentOf\(location\.hash\)\}/);
  assert.match(router, /component: RegisterRoute/, "the registration page keeps its own route");
  assert.match(router, /notFoundComponent: NotFoundPage/, "unknown paths still render the not-found page");
});

test("the invitation page reads the fragment token and previews it before showing the form", () => {
  const page = read(REGISTER);
  assert.match(page, /window\.location\.hash/);
  assert.match(page, /tokenFromFragment\(/);
  assert.match(page, /previewInvitation\(/);
  assert.match(page, /"checking"/);
  assert.match(page, /"refused"/);
  assert.match(page, /<AuthScreen/);
  assert.doesNotMatch(page, /\?token=|searchParams\.get\("token"\)/);
  assert.doesNotMatch(page, /localStorage|sessionStorage|document\.cookie|history\.(replace|push)State|console\./);
});

test("invitation mode fixes the email and hides social sign-in and the account-creation switch", () => {
  const screen = read(SCREEN);
  assert.match(screen, /invitation\?:/);
  assert.match(screen, /invitation\.email/);
  assert.match(screen, /readOnly/);
  assert.match(screen, /invitation\.submit/);
  assert.match(screen, /signup \|\| invitation/);
  const hidden = [...screen.matchAll(/invitation === undefined/g)].length;
  assert.ok(hidden >= 2, "social sign-in and the account-creation entry must both be hidden by invitation mode");
  assert.match(screen, bothWays("socialProviders\\.length > 0", "invitation === undefined"));
  assert.match(screen, bothWays("registrationAvailable", "invitation === undefined"));
});

test("a refused invitation clears to a message with a login link and a created account never reuses the token", () => {
  const page = read(REGISTER);
  assert.match(page, /href="\/login"/);
  assert.match(page, /role="alert"/);
  assert.match(page, /"created"/);
  assert.equal(
    (page.match(/completeInvitation\(/g) ?? []).length,
    1,
    "the single-use token is completed once: no retry after a sign-in failure",
  );
  const complete = page.indexOf("completeInvitation(");
  const signIn = page.indexOf("await signIn(");
  assert.ok(complete > 0, "RegisterPage must call completeInvitation");
  assert.ok(signIn > complete, "the created account signs in only after the invitation is completed");

  const screen = read(SCREEN);
  assert.match(screen, /invitation\.created/);
  assert.match(screen, /Your account was created/);
  assert.match(screen, /href="\/login"/);
});

test("ordinary sign-in keeps its password form, social buttons and the preserved sign-up source", () => {
  const screen = read(SCREEN);
  assert.match(screen, /value\.registration === true/);
  assert.match(screen, /registrationAvailable && invitation === undefined \?/);
  assert.match(screen, /await signIn\(credentials\)/);
  assert.match(screen, /await signUp\(/);
  assert.match(screen, /id="auth-name"/);
  assert.match(screen, /socialProviders\.map\(/);
});
