import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.ts";

export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-grid h-5 min-w-5 place-items-center rounded-[5px] border border-b-2 border-line-strong bg-bg px-[5px] font-mono text-[11px] leading-none font-normal text-fg-muted",
        className,
      )}
      {...props}
    />
  );
}
