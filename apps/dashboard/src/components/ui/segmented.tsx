import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils.ts";

export function Segmented({ label, className, ...props }: ComponentProps<"div"> & { label: string }) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("inline-flex gap-0.5 rounded-[10px] bg-surface p-[3px]", className)}
      {...props}
    />
  );
}

export function SegmentedItem({
  pressed,
  count,
  className,
  children,
  ...props
}: ComponentProps<"button"> & { pressed: boolean; count?: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cn(
        "inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded-sm px-3 text-[13px] whitespace-nowrap transition-colors duration-120",
        pressed ? "bg-bg text-fg shadow-[0_0_0_1px_var(--line)]" : "text-fg-muted hover:text-fg",
        className,
      )}
      {...props}
    >
      {children}
      {count !== undefined ? <span className="nums text-fg-subtle">{count}</span> : null}
    </button>
  );
}
