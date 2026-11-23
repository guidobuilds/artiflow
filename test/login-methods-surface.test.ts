import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import { getCapabilities, signIn, type Capabilities } from "../apps/dashboard/src/auth-client.ts";
import {
  EMERGENCY_COPY,
  EMERGENCY_REACHABLE,
  EMERGENCY_TITLE,
  FALLBACK_PATH,
  METHODS_UNAVAILABLE,
  loginSurface,
} from "../apps/dashboard/src/login-methods.ts";
import { providerLabel, providerMark } from "../apps/dashboard/src/provider-marks.ts";

type Call = { url: string; init: RequestInit };
const realFetch = globalThis.fetch;
const SCREEN = "../apps/dashboard/src/AuthScreen.tsx";
const MARK = "../apps/dashboard/src/components/ui/provider-mark.tsx";
const ORDINARY_REJECTION = "That email and password did not match an account.";

function useFetch(reply: (call: Call, index: number) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const call: Call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return reply(call, calls.length - 1);
  }) as typeof fetch;
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function read(path: string): string {
  const file = new URL(path, import.meta.url);
  assert.ok(existsSync(file), `missing ${path}`);
  return readFileSync(file, "utf8");
}

function section(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `the source defines ${from}`);
  const end = source.indexOf(to, start + from.length);
  assert.ok(end > start, `${from} ends before ${to}`);
  return source.slice(start, end);
}

function methods(overrides: Partial<Capabilities> = {}): Capabilities {
  return { emailPassword: true, registration: false, socialProviders: ["github"], ...overrides };
}

const CONNECTION = { displayName: "Acme Identity", fallbackAvailable: true };

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the page offers exactly the methods the instance has enabled", () => {
  const both = loginSurface(methods(), "");
  assert.equal(both.password, true);
  assert.deepEqual(both.providers, ["github"]);

  const socialOnly = loginSurface(methods({ emailPassword: false }), "");
  assert.equal(socialOnly.password, false, "a disabled password login is never rendered");
  assert.deepEqual(socialOnly.providers, ["github"]);

  const passwordOnly = loginSurface(methods({ socialProviders: [] }), "");
  assert.equal(passwordOnly.password, true);
  assert.deepEqual(passwordOnly.providers, [], "a social provider that is off is never rendered");

  const none = loginSurface(methods({ emailPassword: false, socialProviders: [] }), "");
  assert.equal(none.password, false);
  assert.deepEqual(none.providers, []);
  assert.equal(none.connection, null);
  assert.equal(none.emergency, null);

  const screen = read(SCREEN);
  assert.match(screen, /const surface = loginSurface\(capabilities, search\);/);
  assert.match(screen, /const socialProviders = surface\.providers;/);
  assert.match(screen, /const signInForm = surface\.password \|\| newAccount;/);
  assert.doesNotMatch(screen, /emailPassword/, "the page reads the answered methods, not the raw payload");
});

test("an enabled connection is the only action, labelled with its name and asking for no email", () => {
  const surface = loginSurface(methods({ sso: CONNECTION }), "");
  assert.ok(surface.connection, "the connection reaches the page");
  assert.equal(surface.connection.label, "Acme Identity");
  assert.equal(surface.connection.access, EMERGENCY_REACHABLE, "the emergency alternative is named");
  assert.equal(surface.password, false, "no password form is offered first");
  assert.deepEqual(surface.providers, [], "no social button is offered");
  assert.equal(surface.emergency, null);

  const unnamed = loginSurface(methods({ sso: { displayName: null, fallbackAvailable: true } }), "");
  assert.ok(unnamed.connection);
  assert.equal(unnamed.connection.label, "Single sign-on", "a connection without a name is still labelled");

  const screen = read(SCREEN);
  const panel = section(screen, "function ConnectionPanel", "function EmergencyPanel");
  assert.match(panel, /Sign in with \{notice\.label\}/, "the primary action carries the displayed name");
  assert.doesNotMatch(panel, /<Input|type="email"|auth-email/, "the connection asks for no email first");

  const gate = screen.indexOf("signInForm ?");
  assert.ok(gate > 0, "the conventional form is gated");
  assert.ok(screen.indexOf('id="auth-email"') > gate, "the email field belongs to the gated form");
  assert.ok(screen.indexOf('id="auth-password"') > gate, "the password field belongs to the gated form");
});

test("the fallback parameter reveals the conventional methods with the emergency copy", () => {
  for (const search of ["?fallback=1", "?return=%2Flibrary&fallback=1"]) {
    const surface = loginSurface(methods({ sso: CONNECTION }), search);
    assert.ok(surface.emergency, `${search} reveals the alternative`);
    assert.equal(surface.emergency.title, EMERGENCY_TITLE);
    assert.equal(surface.emergency.copy, EMERGENCY_COPY);
    assert.equal(surface.password, true);
    assert.deepEqual(surface.providers, ["github"]);
    assert.equal(surface.fallbackLink, false, "the alternative is already on screen");
  }

  assert.match(EMERGENCY_TITLE, /administrator/i);
  assert.match(EMERGENCY_COPY, /only administrator accounts/i);
  assert.match(EMERGENCY_COPY, /emergencies/);
  assert.match(EMERGENCY_COPY, /grants no access by itself/);
  assert.doesNotMatch(EMERGENCY_COPY, /fallback/i, "the copy never names the parameter as a way in");
  assert.doesNotMatch(EMERGENCY_COPY, /bypass|unlocks|gains access|grants access/i);

  const withoutPassword = loginSurface(methods({ sso: CONNECTION, emailPassword: false }), "?fallback=1");
  assert.equal(withoutPassword.password, false, "the alternative offers only what is enabled");
  assert.deepEqual(withoutPassword.providers, ["github"]);

  const screen = read(SCREEN);
  assert.match(screen, /\{surface\.emergency \?/);
  const panel = section(screen, "function EmergencyPanel", "export default function AuthScreen");
  assert.match(panel, /\{notice\.title\}/);
  assert.match(panel, /\{notice\.copy\}/);
});

test("each social button shows its provider's own mark, and a provider without a mark shows none", () => {
  const google = providerMark("google");
  const github = providerMark("github");
  assert.ok(google, "google resolves to a mark");
  assert.ok(github, "github resolves to a mark");
  assert.equal(google.src, "/logos/google.svg", "the google button shows the google mark");
  assert.equal(github.src, "/logos/github.svg", "the github button shows the github mark");
  assert.notEqual(google.src, github.src, "two providers never share one asset");
  for (const name of ["google.svg", "github.svg"]) {
    const file = new URL(`../apps/dashboard/public/logos/${name}`, import.meta.url);
    assert.ok(existsSync(file), `the mark asset /logos/${name} exists`);
    assert.match(readFileSync(file, "utf8"), /<svg[\s>]/, `${name} is an svg`);
  }

  assert.equal(providerLabel("github"), "GitHub", "the provider name keeps its own spelling");
  assert.equal(providerLabel("google"), "Google");
  assert.equal(github.monochrome, true, "a single-colour mark is drawn in the icon colour");
  assert.equal(google.monochrome, false, "a multi-colour mark keeps its own colours");

  for (const unknown of ["gitlab", "apple", "", "__proto__", "constructor", "toString"]) {
    assert.equal(providerMark(unknown), null, `${unknown || "(empty)"} has no mark instead of a broken reference`);
  }
  assert.equal(providerLabel("gitlab"), "Gitlab", "an unknown provider still gets a label");

  const screen = read(SCREEN);
  const buttons = section(screen, "socialProviders.map(", "or with email");
  assert.match(buttons, /<ProviderMark provider=\{provider\} \/>/, "each button renders its provider's mark");
  assert.match(buttons, /onClick=\{\(\) => void providerSignIn\(provider\)\}/, "the button still starts that provider");
  assert.match(buttons, /providerLabel\(provider\)/, "the mark sits beside the label");
  assert.doesNotMatch(buttons, /github\.svg|google\.svg/, "the button does not choose the asset itself");

  const mark = read(MARK);
  assert.match(mark, /providerMark\(provider\)/, "the mark is chosen from the answered provider id");
  assert.match(mark, /if \(mark === null\) return null;/, "an unknown provider renders no mark at all");
  assert.match(mark, /alt=""/, "the label names the provider, so the mark stays decorative");
  assert.match(mark, /aria-hidden="true"/);
  assert.match(mark, /bg-current/, "a single-colour mark takes the existing icon colour, in both themes");
  assert.match(mark, /maskImage/, "the mark keeps its shape while its colour comes from the token");
  assert.doesNotMatch(mark, /<svg/, "the mark is the shipped asset, not a redrawn one");
});

test("without the parameter the conventional methods are not rendered at all", () => {
  for (const search of ["", "?", "?return=%2Flibrary", "?fallback=0", "?fallback=true", "?fallback"]) {
    const surface = loginSurface(methods({ sso: CONNECTION }), search);
    assert.equal(surface.password, false, `${search || "(none)"} hides the password form`);
    assert.deepEqual(surface.providers, [], `${search || "(none)"} hides the social buttons`);
    assert.equal(surface.emergency, null, `${search || "(none)"} states no emergency copy`);
  }

  const screen = read(SCREEN);
  assert.match(screen, /const signInForm = surface\.password \|\| newAccount;/);
  assert.equal(
    screen.indexOf("const signInForm"),
    screen.lastIndexOf("const signInForm"),
    "one gate, not a second copy",
  );
});

test("a connection keeps the emergency alternative reachable and promises nothing it cannot offer", () => {
  const surface = loginSurface(methods({ sso: CONNECTION }), "");
  assert.ok(surface.connection);
  assert.equal(surface.connection.access, EMERGENCY_REACHABLE);
  assert.match(EMERGENCY_REACHABLE, /emergency access/);
  assert.equal(surface.fallbackLink, true);
  assert.equal(FALLBACK_PATH, "/login?fallback=1");

  const noAlternative = loginSurface(
    methods({ sso: { displayName: "Acme Identity", fallbackAvailable: false } }),
    "?fallback=1",
  );
  assert.ok(noAlternative.connection);
  assert.equal(noAlternative.fallbackLink, false, "an alternative that does not exist is never promised");
  assert.equal(noAlternative.connection.access, null);
  assert.equal(noAlternative.password, false, "an alternative that does not exist is never rendered");

  const screen = read(SCREEN);
  const panel = section(screen, "function ConnectionPanel", "function EmergencyPanel");
  assert.match(panel, /<Button[^>]*type="button"/, "the connection is the action that starts the flow");
  assert.match(panel, /Sign in with \{notice\.label\}/);
  assert.match(panel, /href=\{fallbackHref\}/);
  assert.doesNotMatch(panel, /<Input/, "the connection asks for no email first");
});

test("the connection reaches the page through the existing capabilities read", async () => {
  const calls = useFetch(() =>
    json({
      emailPassword: true,
      registration: false,
      socialProviders: [],
      sso: { displayName: "Acme Identity", fallbackAvailable: true, fallbackAdministratorsOnly: true },
    }),
  );
  assert.deepEqual(await getCapabilities(), {
    ok: true,
    value: {
      emailPassword: true,
      registration: false,
      socialProviders: [],
      sso: { displayName: "Acme Identity", fallbackAvailable: true },
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/api/auth/capabilities");

  useFetch(() => json({ emailPassword: true, registration: false, socialProviders: ["github"] }));
  const plain = await getCapabilities();
  assert.deepEqual(plain, {
    ok: true,
    value: { emailPassword: true, registration: false, socialProviders: ["github"] },
  });
  assert.equal(JSON.stringify(plain).includes("sso"), false, "an instance without a connection answers as before");

  useFetch(() => json({ emailPassword: true, registration: false, socialProviders: [], sso: { displayName: 7 } }));
  assert.equal((await getCapabilities()).ok, false, "an unreadable connection fails the read instead of guessing");
});

test("a refused administrator-only sign-in reads like any rejected credential", async () => {
  useFetch(() => json({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }, 401));
  const refused = await signIn({ email: "administrator@example.test", password: "wrong-password" });
  assert.equal(refused.ok, false);
  const message = refused.ok === false ? refused.error : "";
  assert.equal(message, ORDINARY_REJECTION);
  assert.doesNotMatch(message, /administrator|emergency|fallback/i);

  const screen = read(SCREEN);
  assert.match(screen, /setError\(result\.error\)/, "the page renders the client's own refusal");

  useFetch(() => json({ error: "unavailable" }, 500));
  const unreadable = await getCapabilities();
  assert.equal(unreadable.ok, false);
  assert.match(METHODS_UNAVAILABLE, /Could not load the sign-in methods/);
  assert.match(screen, /METHODS_UNAVAILABLE/);
  assert.match(screen, /\{readError \?/);
});
