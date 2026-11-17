import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils.ts";
import { Icon, type IconName } from "@/components/ui/icon.tsx";

const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto_32px] items-center gap-2.5 py-0 pr-2 pl-4 min-[861px]:grid-cols-[18px_minmax(0,1fr)_minmax(0,150px)_44px_72px_96px_32px] min-[861px]:gap-3.5";

export function ListBox({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("rounded-lg border border-line", className)} {...props} />;
}

export function ListHead({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      role="rowheader"
      aria-hidden="true"
      className={cn(ROW_GRID, "h-9 border-b border-line text-[12px] text-fg-subtle", className)}
      {...props}
    />
  );
}

export function GroupLabel({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("pt-1 pb-2.5 text-[13px] font-medium text-fg-muted", className)} {...props} />;
}

export function ArtifactRow({ selected, className, ...props }: ComponentProps<"div"> & { selected?: boolean }) {
  return (
    <div
      role="row"
      aria-selected={selected}
      className={cn(
        ROW_GRID,
        "group relative h-[50px] cursor-pointer border-b border-line text-fg-muted outline-none transition-colors duration-120 last:rounded-b-lg last:border-b-0 hover:bg-hover",
        selected && "bg-selected",
        className,
      )}
      {...props}
    />
  );
}

export function RowActions({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "w-8 opacity-0 transition-opacity duration-120 group-hover:opacity-100 group-aria-selected:opacity-100 group-focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100 max-[860px]:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

export function RowIcon({ name, className }: { name: IconName; className?: string }) {
  return (
    <span className={cn("grid text-fg-subtle", className)}>
      <Icon name={name} />
    </span>
  );
}

export function RowTitle({ children }: { children: ReactNode }) {
  return <span className="min-w-0 truncate text-[14px] font-medium text-fg">{children}</span>;
}

export function RowMeta({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("nums truncate text-right font-mono text-[12px] text-fg-subtle", className)}>{children}</span>
  );
}

export function EmptyMessage({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("px-6 py-[72px] text-center text-fg-muted", className)} {...props} />;
}
