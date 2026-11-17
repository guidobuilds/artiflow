import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ThemeProvider } from "@/components/app/theme-provider.tsx";
import { ToastProvider } from "@/components/ui/toast.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import AccountPage from "./AccountPage.tsx";
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
  ) : edit ? (
    <EditorPage artifactId={edit[1]!} />
  ) : (
    <NotFoundPage />
  );

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider>
        <ToastProvider>{page}</ToastProvider>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
