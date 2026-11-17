import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ConsentFlow, viewerHeaders, ViewerAuth, type ConsentSnapshot } from "../plugins/opencode/src/gui-auth.ts";

test("bearer headers are optional, exact, and reject header injection", () => {
  assert.equal(viewerHeaders(null), undefined);
  assert.equal(viewerHeaders("access"), "Authorization: Bearer access");
  assert.throws(() => viewerHeaders("access\r\nX-Injected: yes"));
});

test("viewer remains hidden until the artifact HTTP outcome, including repeated navigation", () => {
  const auth = new ViewerAuth("https://a.example", "a");
  assert.equal(auth.snapshot("e").ready, false);
  auth.navigate("https://other.example/", 200);
  assert.equal(auth.snapshot("e").ready, false);
  auth.navigate(auth.artifactUrl, 200);
  assert.equal(auth.snapshot("e").ready, true);
  auth.beginNavigation();
  assert.equal(auth.snapshot("e").ready, false);
  auth.navigate(auth.artifactUrl, 401);
  assert.equal(auth.snapshot("e").ready, false);
  auth.navigate(auth.artifactUrl, 404);
  assert.equal(auth.snapshot("e").ready, false);
  auth.navigate(auth.artifactUrl, 500);
  assert.equal(auth.snapshot("e").ready, false);
  auth.navigate(auth.artifactUrl, 302);
  assert.equal(auth.snapshot("e").ready, true);
});

test("missing bearer token starts in sign-in fallback without exposing an artifact body", () => {
  const auth = new ViewerAuth("https://a.example", "a", null);
  assert.deepEqual(auth.snapshot("e"), {
    id: "e",
    authRequired: true,
    notFound: false,
    ready: false,
    viewing: false,
    tokenUnavailable: true,
  });
  const login = auth.signIn();
  assert.equal(auth.snapshot("e").ready, false);
  auth.navigate(login, 200);
  assert.equal(auth.snapshot("e").ready, true);
  auth.beginNavigation();
  auth.navigate("https://provider.example/", 200);
  assert.equal(auth.snapshot("e").ready, true);
  assert.equal(auth.navigate("https://a.example/", 200), auth.artifactUrl);
  assert.equal(auth.snapshot("e").ready, false);
  auth.navigate(auth.artifactUrl, 200);
  assert.equal(auth.snapshot("e").ready, true);
});

test("viewer HTTP 401 publishes authRequired; login stays in same view and returns to the artifact", () => {
  const auth = new ViewerAuth("https://a.example", "a");
  assert.equal(auth.navigate(auth.artifactUrl, 401), undefined);
  assert.deepEqual(auth.snapshot("embed"), {
    id: "embed",
    authRequired: true,
    notFound: false,
    ready: false,
    viewing: false,
    tokenUnavailable: false,
  });
  assert.equal(auth.signIn(), "https://a.example/login?return=%2Fartifact%2Fa%3Fembed%3D1");
  assert.deepEqual(auth.snapshot("embed"), {
    id: "embed",
    authRequired: false,
    notFound: false,
    ready: false,
    viewing: false,
    tokenUnavailable: false,
  });
  assert.equal(auth.navigate("https://a.example/login?return=%2Fartifact%2Fa", 200), undefined);
  assert.equal(auth.navigate("https://provider.example/callback", 200), undefined);
  assert.equal(auth.navigate("https://a.example/", 200), auth.artifactUrl);
  assert.equal(auth.navigate(auth.artifactUrl, 200), undefined);
  assert.deepEqual(auth.snapshot("embed"), {
    id: "embed",
    authRequired: false,
    notFound: false,
    ready: true,
    viewing: true,
    tokenUnavailable: false,
  });
});

test("a missing credential is a distinct actionable state that clears once the artifact renders", () => {
  const auth = new ViewerAuth("https://a.example", "a", null);
  assert.deepEqual(auth.snapshot("e"), {
    id: "e",
    authRequired: true,
    notFound: false,
    ready: false,
    viewing: false,
    tokenUnavailable: true,
  });
  auth.signIn();
  auth.navigate("https://a.example/login?return=%2Fartifact%2Fa%3Fembed%3D1", 200);
  assert.equal(auth.snapshot("e").tokenUnavailable, true);
  auth.navigate(auth.artifactUrl, 200);
  assert.equal(auth.snapshot("e").tokenUnavailable, false);
  assert.equal(auth.snapshot("e").viewing, true);
});

test("a viewer reset without a token republishes the missing-credential state, a token clears it", () => {
  const auth = new ViewerAuth("https://a.example", "a", "access");
  assert.equal(auth.snapshot("e").tokenUnavailable, false);
  auth.reset(null);
  assert.deepEqual(auth.snapshot("e"), {
    id: "e",
    authRequired: true,
    notFound: false,
    ready: false,
    viewing: false,
    tokenUnavailable: true,
  });
  auth.reset("access");
  assert.equal(auth.snapshot("e").authRequired, false);
  assert.equal(auth.snapshot("e").tokenUnavailable, false);
});

test("viewer HTTP 404 is a missing artifact, not an auth problem: distinct notFound state", () => {
  const auth = new ViewerAuth("https://a.example", "a");
  assert.equal(auth.navigate(auth.artifactUrl, 404), undefined);
  assert.deepEqual(auth.snapshot("embed"), {
    id: "embed",
    authRequired: false,
    notFound: true,
    ready: false,
    viewing: false,
    tokenUnavailable: false,
  });
  assert.equal(auth.signIn(), "https://a.example/login?return=%2Fartifact%2Fa%3Fembed%3D1");
  assert.equal(auth.navigate("https://a.example/", 200), auth.artifactUrl);
  assert.deepEqual(auth.snapshot("embed"), {
    id: "embed",
    authRequired: false,
    notFound: false,
    ready: false,
    viewing: false,
    tokenUnavailable: false,
  });
});

test("login redirects require authentication while normal artifact navigation remains unchanged", () => {
  const auth = new ViewerAuth("https://a.example", "a/?");
  assert.equal(auth.artifactUrl, "https://a.example/artifact/a%2F%3F?embed=1");
  auth.navigate(auth.artifactUrl, 200);
  assert.equal(auth.snapshot("e").authRequired, false);
  auth.navigate("https://a.example/login", 200);
  assert.equal(auth.snapshot("e").authRequired, true);
  auth.signIn();
  auth.navigate(auth.artifactUrl, 401);
  assert.equal(auth.snapshot("e").authRequired, true);
});

test("user navigation away from the artifact is respected; viewing reports it", () => {
  const auth = new ViewerAuth("https://a.example", "a");
  assert.equal(auth.navigate(auth.artifactUrl, 200), undefined);
  assert.equal(auth.snapshot("embed").viewing, true);
  assert.equal(auth.navigate("https://a.example/", 200), undefined);
  const snapshot = auth.snapshot("embed");
  assert.equal(snapshot.viewing, false);
  assert.equal(snapshot.authRequired, false);
  assert.equal(snapshot.ready, true);
});

test("typed IPC carries per-embed authRequired state and a signIn command; renderer gates native visibility", () => {
  const source = (name: string) => readFileSync(new URL(`../plugins/opencode/src/${name}`, import.meta.url), "utf8");
  assert.match(source("gui-ipc.ts"), /authRequired: Schema.Boolean/);
  assert.match(source("gui-ipc.ts"), /notFound: Schema.Boolean/);
  assert.match(source("gui-ipc.ts"), /viewing: Schema.Boolean/);
  assert.match(source("gui-ipc.ts"), /tokenUnavailable: Schema.Boolean/);
  assert.match(source("gui-ipc.ts"), /signIn: \{ input: Schema.Struct\(\{ id: Schema.String \}\) \}/);
  assert.match(source("gui-main.ts"), /partition: "persist:artiflow"/);
  assert.match(source("gui-main.ts"), /on\("did-navigate"/);
  assert.match(source("gui-main.ts"), /provider.changed\(entry.window\)/);
  assert.match(source("gui.tsx"), /frame.visible\(\) && \(viewState\(\)\?\.ready \?\? false\)/);
  assert.match(source("gui-main.ts"), /on\("did-start-navigation"/);
  assert.match(source("gui-main.ts"), /extraHeaders: viewerHeaders\(token\)/);
});

test("the panel has one auth path: consent with a visible wait and no dashboard button", () => {
  const gui = readFileSync(new URL("../plugins/opencode/src/gui.tsx", import.meta.url), "utf8");
  const banner = readFileSync(new URL("../plugins/opencode/src/gui-banner.ts", import.meta.url), "utf8");
  assert.doesNotMatch(gui, /dashboard sign-in|dashboardSignIn/i);
  assert.doesNotMatch(gui, /views\.signIn\(/);
  assert.doesNotMatch(gui, /Signing in…/);
  assert.match(gui, /\["viewer\.consent"\]\(\{\}, options\)/);
  assert.match(gui, /consentFlow\.cancel\(\)/);
  assert.match(gui, /bannerFor\(/);
  assert.match(banner, /"Sign in to Artiflow"/);
  assert.match(banner, /"Reload artifact"/);
  assert.match(banner, /Waiting for consent in your browser…/);
});

test("sign-in publishes a consent-waiting state that Cancel aborts and clears", async () => {
  const snapshots: ConsentSnapshot[] = [];
  const attempt: { signal?: AbortSignal; reject?: (error: Error) => void } = {};
  const flow = new ConsentFlow(
    (options) =>
      new Promise((_resolve, reject) => {
        attempt.signal = options.signal;
        attempt.reject = reject;
      }),
    () => assert.fail("a cancelled sign-in must not reload the artifact"),
    (snapshot) => snapshots.push(snapshot),
  );
  assert.deepEqual(flow.snapshot(), { status: "idle", message: "" });
  const signing = flow.signIn();
  assert.deepEqual(flow.snapshot(), { status: "pending", message: "" });
  assert.equal(attempt.signal?.aborted, false);
  flow.cancel();
  assert.deepEqual(flow.snapshot(), { status: "idle", message: "" });
  assert.equal(attempt.signal?.aborted, true);
  attempt.reject?.(new Error("aborted"));
  await signing;
  assert.deepEqual(flow.snapshot(), { status: "idle", message: "" });
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.status),
    ["pending", "idle"],
  );
});

test("a consent token authenticates the panel once and reloads the artifact", async () => {
  const snapshots: ConsentSnapshot[] = [];
  const reloads: string[] = [];
  const flow = new ConsentFlow(
    async () => ({ token: "access" }),
    () => {
      reloads.push("reload");
    },
    (snapshot) => snapshots.push(snapshot),
  );
  await flow.signIn();
  assert.deepEqual(flow.snapshot(), { status: "authenticated", message: "" });
  assert.deepEqual(reloads, ["reload"]);
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.status),
    ["pending", "authenticated"],
  );
});

test("a token that arrives after Cancel is ignored: idle state and no reload", async () => {
  let resolveConsent!: (result: { token: string }) => void;
  const reloads: string[] = [];
  const flow = new ConsentFlow(
    () =>
      new Promise((resolve) => {
        resolveConsent = resolve;
      }),
    () => {
      reloads.push("reload");
    },
  );
  const signing = flow.signIn();
  flow.cancel();
  resolveConsent({ token: "access" });
  await signing;
  assert.deepEqual(flow.snapshot(), { status: "idle", message: "" });
  assert.deepEqual(reloads, []);
});

test("a second sign-in click while consent is pending keeps one attempt", async () => {
  let attempts = 0;
  let resolveConsent!: (result: { token: string }) => void;
  const flow = new ConsentFlow(
    () => {
      attempts += 1;
      return new Promise((resolve) => {
        resolveConsent = resolve;
      });
    },
    () => {},
  );
  const first = flow.signIn();
  await flow.signIn();
  assert.equal(attempts, 1);
  resolveConsent({ token: "access" });
  await first;
  assert.equal(flow.snapshot().status, "authenticated");
});

test("consent failures publish an error state and never reload", async () => {
  const reloads: string[] = [];
  const reload = () => {
    reloads.push("reload");
  };
  const denied = new ConsentFlow(async () => ({ error: "denied" }), reload);
  await denied.signIn();
  assert.deepEqual(denied.snapshot(), { status: "error", message: "Artiflow sign-in failed: denied" });
  const offline = new ConsentFlow(async () => {
    throw new Error("offline");
  }, reload);
  await offline.signIn();
  assert.deepEqual(offline.snapshot(), { status: "error", message: "Unable to open Artiflow sign-in." });
  assert.deepEqual(reloads, []);
});

test("a failed artifact reload keeps the authenticated state", async () => {
  const flow = new ConsentFlow(
    async () => ({ token: "access" }),
    async () => {
      throw new Error("viewer unavailable");
    },
  );
  await flow.signIn();
  assert.deepEqual(flow.snapshot(), { status: "authenticated", message: "" });
});
