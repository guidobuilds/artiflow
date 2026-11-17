import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils.ts";
import { Icon, type IconName } from "@/components/ui/icon.tsx";

export function CardGrid({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("tile-mix grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(230px,1fr))]", className)}
      {...props}
    />
  );
}

export function FileTile({ icon, kind, detail }: { icon: IconName; kind: string; detail: string }) {
  return (
    <div
      aria-hidden="true"
      className="file-tile relative grid aspect-[16/8] w-full place-items-center border-b border-line bg-surface text-fg-subtle"
    >
      <Icon name={icon} className="size-6" />
      <span className="absolute bottom-2.5 left-3.5 text-[12px] text-fg-muted">{kind}</span>
      <span className="nums absolute right-3.5 bottom-2.5 font-mono text-[11.5px]">{detail}</span>
    </div>
  );
}

export function Card({
  selected,
  title,
  meta,
  trailing,
  thumb,
  className,
  ...props
}: ComponentProps<"div"> & {
  selected?: boolean;
  title: ReactNode;
  meta: ReactNode;
  trailing?: ReactNode;
  thumb: ReactNode;
}) {
  return (
    <div
      role="row"
      aria-selected={selected}
      className={cn(
        "group relative cursor-pointer rounded-lg border bg-bg-raised outline-none transition-[border-color,transform] duration-120 hover:-translate-y-0.5",
        selected ? "border-accent ring-[3px] ring-accent-wash" : "border-line hover:border-line-strong",
        className,
      )}
      {...props}
    >
      <div className="overflow-hidden rounded-t-[11px]">{thumb}</div>
      <div className="grid gap-1 px-3.5 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-fg">{title}</span>
          {trailing}
        </div>
        <div className="truncate text-[12px] text-fg-subtle">{meta}</div>
      </div>
    </div>
  );
}
