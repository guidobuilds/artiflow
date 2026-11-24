import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const ROUTER = "../apps/dashboard/src/router.tsx";
const MAIN = "../apps/dashboard/src/main.tsx";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

test("the router owns the route tree and carries the query client", () => {
  const router = read(ROUTER);
  assert.match(router, /createRootRouteWithContext<\{ queryClient: QueryClient \}>\(\)/);
  assert.match(router, /import \{ queryClient \} from "\.\/query\/client\.ts";/);
  assert.match(router, /context: \{ queryClient \}/);
  assert.match(read("../apps/dashboard/src/query/client.ts"), /export const queryClient = createQueryClient\(\);/);
  assert.match(read("../apps/dashboard/src/query/provider.tsx"), /import \{ queryClient \} from "\.\/client\.ts";/);
  assert.doesNotMatch(router, /createFileRoute|routeTree\.gen/);
  assert.doesNotMatch(read("../apps/dashboard/vite.config.ts"), /tanstack/i);
  assert.equal(existsSync(new URL("../apps/dashboard/src/routeTree.gen.ts", import.meta.url)), false);
});

test("every path the entry dispatched still mounts the same screen", () => {
  const router = read(ROUTER);
  const routes = [
    ["/", "component: LibraryPage"],
    ["/library", "component: LibraryPage"],
    ["/connect", "component: ConnectRoute"],
    ["/login", "component: LoginRoute"],
    ["/register", "component: RegisterRoute"],
    ["/reset-password", "component: ResetRoute"],
    ["/consent", "component: ConsentRoute"],
    ["/account", "component: AccountPage"],
    ["/admin/users", "component: AdminUsersPage"],
    ["/admin/access", "component: AdminAccessPage"],
    ["/admin/sso", "component: AdminSsoPage"],
    ["/admin/password-policy", "component: AdminPasswordPolicyPage"],
    ["/admin/invitations", "component: AdminInvitationsPage"],
    ["/edit/$artifactId", "component: EditorRoute"],
    ["/canvas/$artifactId", "component: CanvasRoute"],
  ] as const;
  for (const [path, component] of routes) {
    assert.ok(router.includes(`path: "${path}"`), `the router keeps the ${path} route`);
    assert.ok(router.includes(component), `the ${path} route mounts ${component.slice("component: ".length)}`);
  }
  assert.match(router, /<LibraryPage connect \/>/);
  assert.match(router, /<EditorPage artifactId=\{artifactId\} \/>/);
  assert.match(router, /<CanvasEditorPage artifactId=\{artifactId\} \/>/);
});

test("the auth screens read search and hash from the router location", () => {
  const router = read(ROUTER);
  assert.match(router, /\n  useLocation,\n/);
  assert.match(
    router,
    /function LoginRoute\(\) \{\s*const location = useLocation\(\);\s*return <LoginPage search=\{location\.searchStr\} \/>;/,
  );
  assert.match(
    router,
    /function ConsentRoute\(\) \{\s*const location = useLocation\(\);\s*return <ConsentPage search=\{location\.searchStr\} \/>;/,
  );
  assert.match(router, /<RegisterPage hash=\{fragmentOf\(location\.hash\)\} \/>/);
  assert.match(router, /<ResetPage hash=\{fragmentOf\(location\.hash\)\} \/>/);
  assert.match(router, /function fragmentOf\(hash: string\): string \{\s*return hash === "" \? "" : `#\$\{hash\}`;/);
  assert.doesNotMatch(router, /window\.location/);
});

test("an unknown path still renders the not-found page", () => {
  const router = read(ROUTER);
  assert.match(router, /import NotFoundPage from "\.\/NotFoundPage\.tsx";/);
  assert.match(router, /notFoundComponent: NotFoundPage/);
  assert.doesNotMatch(read(MAIN), /NotFoundPage/);
});

test("a failed route offers a retry that resets the query error boundary", () => {
  const router = read(ROUTER);
  assert.match(router, /errorComponent: RouteError/);
  assert.match(router, /const queryErrorResetBoundary = useQueryErrorResetBoundary\(\);/);
  assert.match(
    router,
    /useEffect\(\(\) => \{\s*queryErrorResetBoundary\.reset\(\);\s*\}, \[queryErrorResetBoundary\]\);/,
  );
  assert.match(router, /onClick=\{reset\}/);
});

test("the entry mounts the router inside the unchanged provider stack", () => {
  const main = read(MAIN);
  assert.match(main, /import \{ router \} from "\.\/router\.tsx";/);
  assert.match(main, /import \{ RouterProvider \} from "@tanstack\/react-router";/);
  assert.match(main, /import "\.\/styles\/globals\.css";/);
  assert.match(
    main,
    /<StrictMode>\s*<QueryProvider>\s*<ThemeProvider>\s*<TooltipProvider>\s*<ToastProvider>\s*<RouterProvider router=\{router\} \/>\s*<\/ToastProvider>\s*<\/TooltipProvider>\s*<\/ThemeProvider>\s*<\/QueryProvider>\s*<\/StrictMode>/,
  );
  assert.doesNotMatch(main, /window\.location/);
});

test("nothing dehydrates or hydrates the query cache", () => {
  for (const path of [ROUTER, MAIN]) {
    assert.doesNotMatch(read(path), /dehydrate|hydrate/i, path);
  }
});

test("the detail routes prefetch their read on intent", () => {
  const router = read(ROUTER);
  assert.match(router, /import \{ getDocument \} from "\.\/editor-api\.ts";/);
  assert.match(router, /import \{ getScene \} from "\.\/scene-api\.ts";/);
  assert.match(router, /defaultPreload: "intent"/);
  assert.match(
    router,
    /async function prefetchDocument\(\{[\s\S]*?queryKey: queryKeys\.artifact\.document\(params\.artifactId\)[\s\S]*?queryFn: \(\) => getDocument\(params\.artifactId\)/,
  );
  assert.match(
    router,
    /async function prefetchScene\(\{[\s\S]*?queryKey: queryKeys\.artifact\.scene\(params\.artifactId\)[\s\S]*?queryFn: \(\) => getScene\(params\.artifactId\)/,
  );
  assert.match(router, /path: "\/edit\/\$artifactId",\s*beforeLoad: requireSession,\s*loader: prefetchDocument,/);
  assert.match(router, /path: "\/canvas\/\$artifactId",\s*beforeLoad: requireSession,\s*loader: prefetchScene,/);
});
