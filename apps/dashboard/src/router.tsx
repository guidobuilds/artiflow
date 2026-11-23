import { useEffect } from "react";
import { useQueryErrorResetBoundary, type QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  useLocation,
  type ErrorComponentProps,
} from "@tanstack/react-router";

import { Button } from "@/components/ui/button.tsx";
import AccountPage from "./AccountPage.tsx";
import AdminAccessPage from "./AdminAccessPage.tsx";
import AdminInvitationsPage from "./AdminInvitationsPage.tsx";
import AdminPasswordPolicyPage from "./AdminPasswordPolicyPage.tsx";
import AdminSsoPage from "./AdminSsoPage.tsx";
import AdminUsersPage from "./AdminUsersPage.tsx";
import CanvasEditorPage from "./CanvasEditorPage.tsx";
import ConsentPage from "./ConsentPage.tsx";
import EditorPage from "./EditorPage.tsx";
import LibraryPage from "./LibraryPage.tsx";
import LoginPage from "./LoginPage.tsx";
import NotFoundPage from "./NotFoundPage.tsx";
import RegisterPage from "./RegisterPage.tsx";
import ResetPage from "./ResetPage.tsx";
import { queryClient } from "./query/client.ts";

const ARTIFACT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function fragmentOf(hash: string): string {
  return hash === "" ? "" : `#${hash}`;
}

function RouteError({ reset }: ErrorComponentProps) {
  const queryErrorResetBoundary = useQueryErrorResetBoundary();

  useEffect(() => {
    queryErrorResetBoundary.reset();
  }, [queryErrorResetBoundary]);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-[clamp(20px,5vw,64px)] text-center">
      <h1 className="display text-[32px]">This screen could not load</h1>
      <p role="alert" className="text-fg-muted">
        Try again, or go back to your library.
      </p>
      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
        <a className="text-fg underline" href="/">
          Back to your library
        </a>
      </div>
    </main>
  );
}

function ConnectRoute() {
  return <LibraryPage connect />;
}

function LoginRoute() {
  const location = useLocation();
  return <LoginPage search={location.searchStr} />;
}

function ConsentRoute() {
  const location = useLocation();
  return <ConsentPage search={location.searchStr} />;
}

function RegisterRoute() {
  const location = useLocation();
  return <RegisterPage hash={fragmentOf(location.hash)} />;
}

function ResetRoute() {
  const location = useLocation();
  return <ResetPage hash={fragmentOf(location.hash)} />;
}

function EditorRoute() {
  const { artifactId } = editorRoute.useParams();
  return <EditorPage artifactId={artifactId} />;
}

function CanvasRoute() {
  const { artifactId } = canvasRoute.useParams();
  return <CanvasEditorPage artifactId={artifactId} />;
}

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  notFoundComponent: NotFoundPage,
  errorComponent: RouteError,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: LibraryPage,
});

const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library",
  component: LibraryPage,
});

const connectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connect",
  component: ConnectRoute,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginRoute,
});

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register",
  component: RegisterRoute,
});

const resetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset-password",
  component: ResetRoute,
});

const consentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/consent",
  component: ConsentRoute,
});

const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/account",
  component: AccountPage,
});

const adminUsersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/users",
  component: AdminUsersPage,
});

const adminAccessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/access",
  component: AdminAccessPage,
});

const adminSsoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/sso",
  component: AdminSsoPage,
});

const adminPasswordPolicyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/password-policy",
  component: AdminPasswordPolicyPage,
});

const adminInvitationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/invitations",
  component: AdminInvitationsPage,
});

const editorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/edit/$artifactId",
  params: {
    parse: (params) => (ARTIFACT_ID.test(params.artifactId) ? params : false),
  },
  component: EditorRoute,
});

const canvasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/canvas/$artifactId",
  params: {
    parse: (params) => (ARTIFACT_ID.test(params.artifactId) ? params : false),
  },
  component: CanvasRoute,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  libraryRoute,
  connectRoute,
  loginRoute,
  registerRoute,
  resetRoute,
  consentRoute,
  accountRoute,
  adminUsersRoute,
  adminAccessRoute,
  adminSsoRoute,
  adminPasswordPolicyRoute,
  adminInvitationsRoute,
  editorRoute,
  canvasRoute,
]);

export const router = createRouter({
  routeTree,
  context: { queryClient },
});
