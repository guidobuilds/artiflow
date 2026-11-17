import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.ts";

const tagVariants = cva(
  "inline-flex h-6 items-center gap-1.5 rounded-full border px-[9px] text-[12px] whitespace-nowrap",
  {
    variants: {
      on: {
        true: "border-[color-mix(in_srgb,var(--accent)_45%,transparent)] bg-accent-wash text-accent-text",
        false: "border-line-strong text-fg-muted",
      },
    },
    defaultVariants: { on: false },
  },
);

export type TagProps = ComponentProps<"span"> & VariantProps<typeof tagVariants>;

export function Tag({ className, on, ...props }: TagProps) {
  return <span className={cn(tagVariants({ on }), className)} {...props} />;
}
