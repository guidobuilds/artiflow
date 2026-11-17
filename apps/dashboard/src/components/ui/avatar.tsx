import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.ts";

export function Avatar({ size = "sm", className, ...props }: ComponentProps<"span"> & { size?: "sm" | "lg" }) {
  return (
    <span
      className={cn(
        "inline-grid flex-none place-items-center rounded-full bg-surface-3 font-semibold text-fg-muted ring-2 ring-bg",
        size === "sm" ? "size-7 text-[11px]" : "size-8 text-[11.5px]",
        className,
      )}
      {...props}
    />
  );
}

export function AvatarGroup({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("inline-flex [&>*+*]:-ml-1", className)} {...props} />;
}
