import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils.ts";

export function Terminal({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "grid gap-0.5 rounded-lg border border-line-strong bg-bg p-5 font-mono text-[13px] leading-[1.7] [overflow-wrap:anywhere]",
        className,
      )}
      {...props}
    />
  );
}

export function TerminalPrompt({ children }: { children: ReactNode }) {
  return (
    <p className="mb-3 text-fg">
      <span aria-hidden="true" className="text-accent-text">
        &gt;{" "}
      </span>
      {children}
    </p>
  );
}

export function TerminalTool({ lit, children }: { lit?: boolean; children: ReactNode }) {
  return (
    <p className="text-fg-muted">
      <span aria-hidden="true" className={lit ? "text-accent" : "text-fg-subtle"}>
        ●{" "}
      </span>
      {children}
    </p>
  );
}

export function TerminalOutput({ className, children }: { className?: string; children: ReactNode }) {
  return <p className={cn("pl-[1.2em] text-fg-subtle", className)}>{children}</p>;
}
