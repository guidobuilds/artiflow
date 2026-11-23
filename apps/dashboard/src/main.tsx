import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";

import { ThemeProvider } from "@/components/app/theme-provider.tsx";
import { QueryProvider } from "@/query/provider.tsx";
import { ToastProvider } from "@/components/ui/toast.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { router } from "./router.tsx";
import "./styles/globals.css";

const container = document.getElementById("root");
if (!container) throw new Error("Artiflow: missing #root container");

createRoot(container).render(
  <StrictMode>
    <QueryProvider>
      <ThemeProvider>
        <TooltipProvider>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryProvider>
  </StrictMode>,
);
