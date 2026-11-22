import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils.ts";

export function settingIds(id: string): { label: string; description: string } {
  return { label: `${id}-label`, description: `${id}-description` };
}

export function SettingsSection({
  id,
  title,
  description,
  action,
  className,
  children,
  ...props
}: Omit<ComponentProps<"section">, "title"> & {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-heading`} className={cn("grid gap-3", className)} {...props}>
      <header className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1.5">
        <div className="grid min-w-0 gap-1">
          <h2 id={`${id}-heading`} className="text-[15px] font-semibold tracking-[-0.02em]">
            {title}
          </h2>
          {description ? <p className="max-w-[64ch] text-[13px] text-fg-muted">{description}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function SettingsCard({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,1fr)] divide-y divide-line overflow-hidden rounded-lg border border-line bg-bg-raised",
        className,
      )}
      {...props}
    />
  );
}

export function ActionRow({
  id,
  label,
  description,
  leading,
  control,
  className,
  children,
}: {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  control?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  const ids = settingIds(id);
  return (
    <div className={cn("grid gap-4 px-4 py-3.5", className)}>
      <div className="flex min-w-0 items-center gap-3.5">
        {leading}
        <div className="grid min-w-0 flex-1 gap-0.5">
          <span id={ids.label} className="text-[14px] font-medium text-fg">
            {label}
          </span>
          {description ? (
            <span id={ids.description} className="text-[13px] text-fg-muted">
              {description}
            </span>
          ) : null}
        </div>
        {control ? <div className="flex shrink-0 items-center gap-2">{control}</div> : null}
      </div>
      {children}
    </div>
  );
}
