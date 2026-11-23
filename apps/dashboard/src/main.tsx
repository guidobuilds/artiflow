import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ThemeProvider } from "@/components/app/theme-provider.tsx";
import { QueryProvider } from "@/query/provider.tsx";
import { ToastProvider } from "@/components/ui/toast.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import AccountPage from "./AccountPage.tsx";
import AdminAccessPage from "./AdminAccessPage.tsx";
import AdminInvitationsPage from "./AdminInvitationsPage.tsx";
import AdminPasswordPolicyPage from "./AdminPasswordPolicyPage.tsx";
import AdminSsoPage from "./AdminSsoPage.tsx";
import AdminUsersPage from "./AdminUsersPage.tsx";
import CanvasEditorPage from "./CanvasEditorPage.tsx";
import ConsentPage from "./ConsentPage.tsx";
import LibraryPage from "./LibraryPage.tsx";
import EditorPage from "./EditorPage.tsx";
import LoginPage from "./LoginPage.tsx";
import NotFoundPage from "./NotFoundPage.tsx";
import RegisterPage from "./RegisterPage.tsx";
import ResetPage from "./ResetPage.tsx";
import "./styles/globals.css";

const container = document.getElementById("root");
if (!container) throw new Error("Artiflow: missing #root container");

const path = window.location.pathname;
const edit = /^\/edit\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(path);
const canvas = /^\/canvas\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(path);
const page =
  path === "/consent" ? (
    <ConsentPage search={window.location.search} />
  ) : path === "/login" ? (
    <LoginPage search={window.location.search} />
  ) : path === "/register" ? (
    <RegisterPage hash={window.location.hash} />
  ) : path === "/reset-password" ? (
    <ResetPage hash={window.location.hash} />
  ) : path === "/" || path === "/library" ? (
    <LibraryPage />
  ) : path === "/connect" ? (
    <LibraryPage connect />
  ) : path === "/account" ? (
    <AccountPage />
  ) : path === "/admin/users" ? (
    <AdminUsersPage />
  ) : path === "/admin/access" ? (
    <AdminAccessPage />
  ) : path === "/admin/sso" ? (
    <AdminSsoPage />
  ) : path === "/admin/password-policy" ? (
    <AdminPasswordPolicyPage />
  ) : path === "/admin/invitations" ? (
    <AdminInvitationsPage />
  ) : edit ? (
    <EditorPage artifactId={edit[1]!} />
  ) : canvas ? (
    <CanvasEditorPage artifactId={canvas[1]!} />
  ) : (
    <NotFoundPage />
  );

createRoot(container).render(
  <StrictMode>
    <QueryProvider>
      <ThemeProvider>
        <TooltipProvider>
          <ToastProvider>{page}</ToastProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryProvider>
  </StrictMode>,
);
