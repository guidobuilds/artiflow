import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.ts";

export function Switch({
  checked,
  onCheckedChange,
  className,
  onClick,
  ...props
}: Omit<ComponentProps<"button">, "role" | "aria-checked" | "onChange"> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onCheckedChange(!checked);
      }}
      className={cn(
        "group relative inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full border transition-colors duration-120 outline-none",
        "focus-visible:ring-[3px] focus-visible:ring-accent-wash disabled:cursor-not-allowed disabled:opacity-40",
        checked ? "border-accent bg-accent" : "border-line-strong bg-surface-3",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-1/2 size-4 -translate-y-1/2 rounded-full transition-[left,background-color] duration-120 ease-(--ease)",
          checked ? "left-[18px] bg-white" : "left-[2px] bg-fg-muted",
        )}
      />
    </button>
  );
}
