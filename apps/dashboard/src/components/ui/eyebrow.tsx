import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.ts";

export function Eyebrow({ className, children, ...props }: ComponentProps<"p">) {
  return (
    <p className={cn("inline-flex items-center gap-2 text-[13px] font-medium text-fg-muted", className)} {...props}>
      <span aria-hidden="true" className="size-[7px] rounded-full bg-accent" />
      {children}
    </p>
  );
}
