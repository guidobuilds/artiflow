import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import {
  LIBRARY_POLL_MS,
  fetchArtifacts,
  fetchSharedArtifacts,
  formatBytes,
  getPublicClient,
  parseArtifactList,
  startLibraryPolling,
} from "../apps/dashboard/src/auth-client.ts";
import { safeInternalPath } from "../apps/dashboard/src/lib/utils.ts";

type Call = { url: string; init: RequestInit };
const realFetch = globalThis.fetch;

function useFetch(reply: (call: Call, index: number) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const call: Call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return reply(call, calls.length - 1);
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const artifact = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Artifact ${id}`,
  createdAt: "2026-10-19T08:30:00.000Z",
  updatedAt: "2026-10-19T09:00:00.000Z",
  observedSizeBytes: 1536,
  revisionCount: 2,
  revisionNumber: 3,
  currentRevisionId: "rev-2",
  sha256: "a".repeat(64),
  ...extra,
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("SPA 404 shows the safely rendered requested path in a terminal sample", () => {
  const page = source("../apps/dashboard/src/NotFoundPage.tsx");
  assert.match(page, /const requestedPath = window\.location\.pathname/);
  assert.match(page, /<Terminal\b[\s\S]*GET \{requestedPath\}[\s\S]*<\/Terminal>/);
  assert.match(page, /className="caret"/);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
  assert.match(page, /<a\s+href="\/"[^>]*>\s*Back to your library\s*<\/a>/);
  const css = source("../apps/dashboard/src/styles/globals.css");
  assert.match(css, /\.caret\s*\{/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  const library = source("../apps/dashboard/src/LibraryPage.tsx");
  assert.match(library, /window\.location\.replace\(\s*"\/login\?return="/);
});

test("authorization states remain perceivable without decorative status tags", () => {
  const login = source("../apps/dashboard/src/LoginPage.tsx");
  const consent = source("../apps/dashboard/src/ConsentPage.tsx");
  for (const page of [login, consent]) {
    assert.doesNotMatch(page, /<Tag\b/);
    assert.match(page, /aria-busy=/);
    assert.match(page, /role="alert"/);
    assert.match(page, /disabled=\{busy\}/);
  }
  assert.match(login, /Checking your account…/);
  assert.match(login, /Continuing authorization…/);
  assert.match(consent, /Loading the requesting application/);
});

test("ordinary authorization links use neutral underlined styling", () => {
  for (const path of ["LibraryPage.tsx", "LoginPage.tsx", "ConsentPage.tsx"]) {
    const links = source(`../apps/dashboard/src/${path}`).match(/<a\s[^>]*>/g) ?? [];
    for (const link of links) {
      assert.doesNotMatch(link, /accent/);
      assert.match(link, /text-fg(?:-muted)?\b/);
      assert.match(link, /underline/);
    }
  }
});

test("revealed links retain their controls with a neutral temporary notice only", () => {
  const share = source("../apps/dashboard/src/ShareModal.tsx");
  const notice = share.slice(share.indexOf("{notice ? ("), share.indexOf('{links.kind === "error"'));
  assert.match(notice, /role="status"/);
  assert.doesNotMatch(notice, /danger/);
  assert.match(notice, /text-fg-subtle/);
  assert.match(notice, /notice\.url/);
  assert.match(notice, /Copy URL/);
  assert.match(notice, /dismissToken\(\)/);
  assert.doesNotMatch(share, /TOKEN_ONCE_WARNING/);
  assert.doesNotMatch(source("../apps/dashboard/src/auth-client.ts"), /export const TOKEN_ONCE_WARNING/);
});

test("library and sign-in omit development copy while polling remains wired", () => {
  const library = source("../apps/dashboard/src/LibraryPage.tsx");
  assert.doesNotMatch(library, /VIEWER_NOTE|REFRESH_NOTE|Refreshing…|>Refresh</);
  assert.match(library, /startLibraryPolling\(\(\) => load\(\)\)/);
  assert.doesNotMatch(source("../apps/dashboard/src/LoginPage.tsx"), /local account|127\.0\.0\.1|No email is sent/);
  const html = source("../apps/dashboard/index.html");
  assert.match(html, /<title>Artiflow<\/title>/);
  assert.doesNotMatch(html, /name="description"/);
});

test("authorization section labels use sentence case and preserve technical acronyms", () => {
  assert.match(source("../apps/dashboard/src/LoginPage.tsx"), />\s*Sign in to continue\s*</);
  assert.match(source("../apps/dashboard/src/ConsentPage.tsx"), />\s*It will be able to\s*</);
  assert.match(source("../apps/dashboard/src/LibraryPage.tsx"), /label: "Page"/);
});

test("the list payload maps to only what the page renders, in same-origin links", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-19T11:00:00.000Z") });
  useFetch(() =>
    json({
      artifacts: [
        artifact("art-1"),
        artifact("art-2", { title: "  ", observedSizeBytes: null, revisionCount: 1 }),
        artifact("art-3", { observedSizeBytes: 0, revisionCount: 0, revisionNumber: null }),
      ],
    }),
  );
  const result = await fetchArtifacts();
  assert.equal(result.ok, true);
  const rows = result.ok ? result.value : [];
  assert.deepEqual(rows[0], {
    id: "art-1",
    title: "Artifact art-1",
    kind: "html",
    createdLabel: "2026-10-19",
    createdAt: "2026-10-19T08:30:00.000Z",
    updatedAt: "2026-10-19T09:00:00.000Z",
    sizeLabel: "1.5 KB",
    versionsLabel: "2 versions",
    verLabel: "v3",
    relLabel: "2h",
    viewerHref: "/artifact/art-1",
  });
  assert.deepEqual(
    [rows[1]?.title, rows[1]?.sizeLabel, rows[1]?.versionsLabel],
    ["Untitled artifact", "size unknown", "1 version"],
  );
  assert.deepEqual([rows[2]?.sizeLabel, rows[2]?.versionsLabel, rows[2]?.verLabel], ["0 B", "no version yet", ""]);
  assert.deepEqual(
    rows.map((row) => /^\/artifact\/[^/]+$/.test(row.viewerHref)),
    [true, true, true],
  );
});

test("kind rides the summary: markdown stays markdown, everything else defaults to html", () => {
  const rows = parseArtifactList({
    artifacts: [artifact("doc", { kind: "markdown" }), artifact("page", { kind: "html" }), artifact("legacy", {})],
  });
  assert.deepEqual(
    rows?.map(({ kind }) => kind),
    ["markdown", "html", "html"],
  );
});

test("raw library timestamps preserve strings and map other values to null", () => {
  const rows = parseArtifactList({
    artifacts: [artifact("a", { createdAt: null, updatedAt: 42 }), artifact("b", { updatedAt: undefined })],
  });
  assert.deepEqual(
    rows?.map(({ createdAt, updatedAt, createdLabel }) => ({ createdAt, updatedAt, createdLabel })),
    [
      { createdAt: null, updatedAt: null, createdLabel: "date unknown" },
      { createdAt: "2026-10-19T08:30:00.000Z", updatedAt: null, createdLabel: "2026-10-19" },
    ],
  );
});

test("short updated labels cover minute, hour, day and calendar boundaries with created fallback", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-25T12:00:00.000Z") });
  const times = [
    "2026-10-25T12:00:00.000Z",
    "2026-10-25T11:01:00.000Z",
    "2026-10-25T11:00:00.000Z",
    "2026-10-24T13:00:00.000Z",
    "2026-10-24T12:00:00.000Z",
    "2026-10-19T12:00:00.000Z",
    "2026-10-18T12:00:00.000Z",
  ];
  const rows = parseArtifactList({
    artifacts: [
      ...times.map((updatedAt) => artifact(updatedAt, { updatedAt })),
      artifact("fallback", { updatedAt: null, createdAt: "2026-10-25T10:00:00.000Z", revisionNumber: undefined }),
      artifact("unknown", { updatedAt: "invalid", createdAt: null }),
    ],
  });
  assert.deepEqual(
    rows?.map(({ relLabel }) => relLabel),
    ["now", "59m", "1h", "23h", "1d", "6d", "Oct 18", "2h", "date unknown"],
  );
  assert.equal(rows?.[7]?.verLabel, "");
  assert.equal(
    parseArtifactList({ artifacts: [artifact("valid"), {}] }),
    null,
    "one invalid row still unverifies the entire list",
  );
});

test("sizes are human readable and never guessed for a missing value", () => {
  assert.deepEqual([0, 1023, 1536, 16 * 1024 * 1024].map(formatBytes), ["0 B", "1023 B", "1.5 KB", "16 MB"]);
  assert.deepEqual([null, Number.NaN].map(formatBytes), ["size unknown", "size unknown"]);
});

test("return paths allow only internal paths without whitespace or backslashes", () => {
  for (const value of ["/", "/library?x=1", "/consent?client_id=x&scope=openid%20email"]) {
    assert.equal(safeInternalPath(value), value);
  }
  for (const value of ["", "//evil.com", "/\\evil", "https://x", " /x", "/x y", "/x\n", "/\tevil.com", "/x\\y"]) {
    assert.equal(safeInternalPath(value), null, JSON.stringify(value));
  }
});

test("session-gated pages replace the route and hide their shell while redirecting", () => {
  const library = source("../apps/dashboard/src/LibraryPage.tsx");
  const consent = source("../apps/dashboard/src/ConsentPage.tsx");
  for (const page of [library, consent]) {
    assert.match(
      page,
      /window\.location\.replace\(\s*"\/login\?return=" \+ encodeURIComponent\(window\.location\.pathname \+ window\.location\.search\),?\s*\)/,
    );
    assert.match(page, /redirecting/);
    assert.match(page, /return null/);
    assert.doesNotMatch(page, /sign-in page/);
  }
  assert.match(library, /state\.kind === "loading"[^;]*return null/);
  const auth = source("../apps/dashboard/src/AuthScreen.tsx");
  assert.match(auth, /safeInternalPath\(new URLSearchParams\(search\)\.get\("return"\) \?\? ""\) \?\? "\/"/);
  assert.match(auth, /window\.location\.assign\(returnPath\)/);
});

test("polling exposes expired sessions from either library read without an empty success", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  useFetch(() => json({ error: "unauthorized" }, 401));
  let refresh: Promise<unknown[]> | undefined;
  const stop = startLibraryPolling(() => {
    refresh = Promise.all([fetchArtifacts(), fetchSharedArtifacts()]);
  });
  t.mock.timers.tick(15_000);
  assert.deepEqual(
    await refresh,
    Array(2).fill({
      ok: false,
      error: "This browser has no signed-in account, so the library cannot be listed. Sign in first.",
      signInRequired: true,
    }),
  );
  stop();
});

test("consent read distinguishes a missing session from retryable errors", async () => {
  useFetch(() => json({ error: "unauthorized" }, 401));
  assert.deepEqual(await getPublicClient("client"), {
    ok: false,
    error: "This browser has no signed-in account, so nothing can be approved. Sign in first.",
    signInRequired: true,
  });
  useFetch(() => json({}, 500));
  const failed = await getPublicClient("client");
  assert.equal(failed.ok === false && failed.signInRequired, false);
});

test("no session signals navigation instead of an empty library", async () => {
  const calls = useFetch(() => json({ error: "unauthorized" }, 401));
  const result = await fetchArtifacts();
  assert.equal(result.ok === false && result.signInRequired, true);
  assert.equal(result.ok === false && /sign in/i.test(result.error), true);
  assert.deepEqual(
    [calls[0]?.url, calls[0]?.init.method, calls[0]?.init.cache, calls[0]?.init.credentials],
    ["/api/artifacts", "GET", "no-store", "same-origin"],
  );
});

test("a failing or unreadable list is a generic error, never server text or an empty list", async () => {
  useFetch(() => json({ message: "db password secret-value" }, 500));
  const failed = await fetchArtifacts();
  assert.equal(failed.ok === false && failed.error.includes("secret-value"), false);
  assert.equal(failed.ok === false && failed.signInRequired, false);
  useFetch(() => json({ artifacts: "not-a-list" }));
  assert.equal((await fetchArtifacts()).ok, false);
  assert.equal(parseArtifactList({ artifacts: [{}] }), null);
  assert.deepEqual(parseArtifactList({ artifacts: [] }), []);
  globalThis.fetch = (async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:8787");
  }) as typeof fetch;
  const offline = await fetchArtifacts();
  assert.equal(offline.ok === false && offline.error.includes("ECONNREFUSED"), false);
});

test("refresh refetches the list instead of reusing the previous answer", async () => {
  const calls = useFetch((_call, index) => json({ artifacts: index === 0 ? [] : [artifact("art-1")] }));
  assert.deepEqual(await fetchArtifacts(), { ok: true, value: [] });
  const second = await fetchArtifacts();
  assert.equal(second.ok === true && second.value.length, 1);
  assert.equal(calls.length, 2);
});

test("polling is one slow bounded timer that the returned stop clears", () => {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const scheduled: { handler: () => void; delay: number }[] = [];
  const cleared: unknown[] = [];
  const timer: unknown = { id: "timer-1" };
  globalThis.setInterval = ((handler: () => void, delay: number) => {
    scheduled.push({ handler, delay });
    return timer;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((handle: unknown) => {
    cleared.push(handle);
  }) as unknown as typeof clearInterval;
  try {
    let refreshed = 0;
    const stop = startLibraryPolling(() => {
      refreshed += 1;
    });
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0]?.delay, LIBRARY_POLL_MS);
    assert.equal(LIBRARY_POLL_MS >= 10_000, true);
    scheduled[0]?.handler();
    assert.equal(refreshed, 1);
    stop();
    assert.deepEqual(cleared, [timer]);
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
});

test("the connect overlay is a labelled dialog with agent tabs and three named steps", () => {
  const dialog = source("../apps/dashboard/src/ConnectDialog.tsx");
  assert.match(dialog, /<DialogTitle\b[^>]*>Connect an agent<\/DialogTitle>/);
  assert.match(dialog, /role="tablist"[\s\S]*?aria-label="Agent"/);
  assert.match(dialog, /role="tabpanel"[\s\S]*?aria-labelledby=\{`\$\{id\}-tab-\$\{clientIndex\}`\}/);
  assert.match(dialog, /const STEPS = \["Add server", "Approve", "Try it"\] as const;/);
  assert.match(dialog, /aria-current=\{index === step \? "step" : undefined\}/);
  const figure = dialog.match(/<figure\b[\s\S]*?<\/figure>/)?.[0];
  assert.ok(figure);
  assert.doesNotMatch(figure, /<button\b|<Button\b/);
  assert.match(dialog, /artifactCount !== undefined \? \(\s*<p role="status"/);
  const main = source("../apps/dashboard/src/main.tsx");
  assert.match(main, /path === "\/connect" \? \(\s*<LibraryPage connect \/>/);
});

test("sidebar recent titles truncate inside the fixed column and keep the full text on hover", () => {
  const shell = source("../apps/dashboard/src/components/app/app-shell.tsx");
  const recent = shell.match(/<section\s+aria-labelledby="recent-heading"[\s\S]*?<\/section>/)?.[0];
  assert.ok(recent);
  assert.match(recent, /grid-cols-\[minmax\(0,1fr\)\]/);
  assert.match(recent, /onClick=\{item\.onOpen\}\s*title=\{item\.title\}/);
  assert.match(recent, /className="flex h-8 min-w-0 cursor-pointer/);
  assert.match(recent, /<span className="min-w-0 flex-1 truncate">\{item\.title\}<\/span>/);
});
