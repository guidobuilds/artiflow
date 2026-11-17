import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.ts";

const buttonVariants = cva(
  "inline-flex cursor-pointer items-center justify-center gap-2 rounded-md text-[13.5px] leading-none font-medium whitespace-nowrap transition-colors duration-120 select-none disabled:cursor-not-allowed disabled:opacity-40",
  {
    variants: {
      variant: {
        primary: "bg-fg text-bg enabled:hover:bg-[color-mix(in_oklab,var(--fg)_86%,var(--bg))]",
        secondary: "border border-line-strong bg-surface-2 text-fg enabled:hover:bg-surface-3",
        ghost: "text-fg-muted enabled:hover:bg-hover enabled:hover:text-fg",
        danger: "bg-danger text-white enabled:hover:opacity-90",
        "danger-ghost": "text-danger-text enabled:hover:bg-hover",
      },
      size: {
        md: "h-[38px] px-4",
        sm: "h-[30px] px-[11px] text-[12.5px]",
        icon: "size-[38px] p-0",
      },
    },
    compoundVariants: [{ variant: "ghost", size: "md", className: "px-3" }],
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export function ButtonGroup({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("inline-flex items-center gap-2", className)} {...props} />;
}

export { buttonVariants };
