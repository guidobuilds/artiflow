import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";

import { safeInternalPath } from "../apps/dashboard/src/lib/utils.ts";
import { queryKeys } from "../apps/dashboard/src/query/keys.ts";
import { continuationOf, loginHref, loginTarget, signedOutRedirect } from "../apps/dashboard/src/route-guards.ts";

const SRC = "../apps/dashboard/src";
const ROUTER = `${SRC}/router.tsx`;
const SHELL = `${SRC}/components/app/app-shell.tsx`;

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

const SESSION_ROUTES = [
  "/",
  "/library",
  "/connect",
  "/account",
  "/admin/users",
  "/admin/access",
  "/admin/sso",
  "/admin/password-policy",
  "/admin/invitations",
  "/edit/$artifactId",
  "/canvas/$artifactId",
];

const PUBLIC_ROUTES = ["/login", "/register", "/reset-password", "/consent"];

const USER = { id: "user-1", name: "Ada", email: "ada@example.com", image: null };

function routeBlock(router: string, path: string): string {
  for (const candidate of router.split("createRoute({").slice(1)) {
    const block = candidate.split("\n});")[0]!;
    if (block.includes(`path: "${path}"`)) return block;
  }
  throw new Error(`the router no longer declares ${path}`);
}

function client(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
}

async function withSessionFetch(reply: () => Response, run: (calls: string[]) => Promise<void>) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    return reply();
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const answer = (body: unknown, status = 200) =>
  new Response(body === null ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("the guard sends a signed-out visitor back to the path and search it asked for", async () => {
  assert.deepEqual(loginTarget("/admin/users", "?page=2"), {
    to: "/login",
    search: { return: "/admin/users?page=2" },
  });
  const target = loginTarget("/library", "?filter=shared");
  const handing = new URLSearchParams(target.search).toString();
  const returned = safeInternalPath(new URLSearchParams(handing).get("return") ?? "") ?? "/";
  assert.equal(returned, "/library?filter=shared");
  assert.equal(loginHref("/edit/abc", ""), "/login?return=%2Fedit%2Fabc");
  await withSessionFetch(
    () => answer(null),
    async () => {
      assert.deepEqual(await signedOutRedirect(client(), "/admin/users", "?page=2"), {
        to: "/login",
        search: { return: "/admin/users?page=2" },
      });
    },
  );
});

test("an external or malformed continuation degrades to the library", () => {
  for (const pathname of ["//evil.com", "/\\evil", "https://evil.example", "/x y", "/x\n", "/\tevil.com"]) {
    assert.equal(continuationOf(pathname, ""), "/", JSON.stringify(pathname));
    assert.equal(loginTarget(pathname, "").search.return, "/", JSON.stringify(pathname));
  }
  assert.equal(continuationOf("/", ""), "/");
});

test("only a session read that says nobody is signed in redirects", async () => {
  await withSessionFetch(
    () => answer({ user: USER }),
    async () => {
      const queryClient = client();
      assert.equal(await signedOutRedirect(queryClient, "/library", ""), null);
      assert.deepEqual(queryClient.getQueryData(queryKeys.auth.session), USER);
    },
  );
});

test("a failed session read stays an error instead of being read as signed out", async () => {
  await withSessionFetch(
    () => answer({ error: "down" }, 500),
    async (calls) => {
      const queryClient = client();
      await assert.rejects(signedOutRedirect(queryClient, "/library", ""), /answered unexpectedly/);
      assert.equal(queryClient.getQueryState(queryKeys.auth.session)?.status, "error");
      assert.equal(calls.length, 1);
    },
  );
});

test("every session route declares the guard and the public routes stay open", () => {
  const router = read(ROUTER);
  for (const path of SESSION_ROUTES) assert.match(routeBlock(router, path), /beforeLoad: requireSession/, path);
  for (const path of PUBLIC_ROUTES) assert.doesNotMatch(routeBlock(router, path), /beforeLoad/, path);
  assert.match(
    router,
    /const requireSession = async \(\{\s*context,\s*location,\s*\}: \{\s*context: \{ queryClient: QueryClient \};\s*location: \{ pathname: string; searchStr: string \};\s*\}\)/, 
  );
  assert.match(router, /const target = await signedOutRedirect\(context\.queryClient, location\.pathname, location\.searchStr\);/);
  assert.match(router, /if \(target !== null\) throw redirect\(target\);/);
  assert.doesNotMatch(router, /\.clear\(\)|resetQueries|removeQueries/);
});

test("the shell and the screens no longer redirect on their own", () => {
  const shell = read(SHELL);
  assert.doesNotMatch(shell, /requireSession/);
  assert.doesNotMatch(shell, /redirecting/);
  assert.doesNotMatch(shell, /window\.location\.replace/);
  assert.doesNotMatch(read(`${SRC}/AccountPage.tsx`), /requireSession/);
  const library = read(`${SRC}/LibraryPage.tsx`);
  assert.doesNotMatch(library, /window\.location\.replace/);
  assert.doesNotMatch(library, /redirecting/);
  for (const page of ["EditorPage.tsx", "CanvasEditorPage.tsx"]) {
    assert.doesNotMatch(read(`${SRC}/${page}`), /window\.location\.replace/, page);
  }
});

test("consent still bounces a visitor the request needs signed in", () => {
  assert.match(read(`${SRC}/ConsentPage.tsx`), /window\.location\.replace\(loginHref\(window\.location\.pathname, window\.location\.search\)\)/);
});
