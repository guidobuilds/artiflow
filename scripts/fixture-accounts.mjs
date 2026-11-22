#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOKEN_MARKER = "#token=";
const REQUEST_TIMEOUT_MS = 20_000;
const TOOLCHAIN_BUN = "/toolchain/bun";

const request = (base, pathname, init = {}) =>
  fetch(`${base}${pathname}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

const cookieOf = (response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .find((value) => value.includes("session_token")) ?? null;

export const bunBinary = () =>
  [process.env.ARTIFLOW_BUN, TOOLCHAIN_BUN].find((candidate) => candidate !== undefined && fs.existsSync(candidate)) ??
  "bun";

function childPathFor(bun, base = process.env.PATH ?? "") {
  const dir = path.dirname(bun);
  return [dir === "." ? "" : dir, base].filter((part) => part !== "").join(":");
}

export function issueInvitationUrl({ origin, email, databaseUrl = process.env.DATABASE_URL, bun = bunBinary() }) {
  assert.ok(databaseUrl, "DATABASE_URL is required to issue a registration invitation");
  const result = spawnSync(bun, ["run", "--silent", "user:invite", email], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: childPathFor(bun),
      DATABASE_URL: databaseUrl,
      ARTIFLOW_PUBLIC_ORIGIN: origin,
    },
  });
  assert.equal(result.status, 0, `user:invite answered ${result.status}`);
  const url = (result.stdout ?? "").trimEnd();
  assert.equal(
    url.startsWith(`${origin}/register${TOKEN_MARKER}`),
    true,
    "user:invite printed no invitation URL for the expected origin",
  );
  return url;
}

export const tokenFromInvitationUrl = (url) => {
  const marker = url.indexOf(TOKEN_MARKER);
  assert.ok(marker >= 0, "the invitation URL carries no fragment token");
  return url.slice(marker + TOKEN_MARKER.length);
};

export async function signInFixture({ base, origin, credentials }) {
  const response = await request(base, "/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email: credentials.email, password: credentials.password }),
  });
  return response.status === 200 ? cookieOf(response) : null;
}

export async function ensureFixtureSession({
  base,
  origin,
  credentials,
  databaseUrl = process.env.DATABASE_URL,
  bun = bunBinary(),
  allowCreate = true,
}) {
  const existing = await signInFixture({ base, origin, credentials });
  if (existing) return { cookie: existing, created: false };
  assert.ok(allowCreate, "sign-in failed and this run may not provision a new account");
  assert.equal(
    typeof credentials.name === "string" && credentials.name.trim() !== "",
    true,
    "a fixture display name is required to complete a registration invitation",
  );

  const token = tokenFromInvitationUrl(issueInvitationUrl({ origin, email: credentials.email, databaseUrl, bun }));
  const completion = await request(base, "/api/auth/registration/complete", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ token, name: credentials.name, password: credentials.password }),
  });
  if (completion.status !== 200) {
    const refusal = await completion.json().catch(() => null);
    assert.fail(`the invitation completion answered ${completion.status} (${refusal?.code ?? "no code"})`);
  }
  assert.equal((await completion.json())?.ok, true, "the invitation completion did not confirm the account");

  const cookie = await signInFixture({ base, origin, credentials });
  assert.ok(cookie, "the invited account cannot sign in with the configured password");
  return { cookie, created: true };
}
