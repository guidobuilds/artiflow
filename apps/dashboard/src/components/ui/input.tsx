import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils.ts";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-md border border-line-strong bg-bg px-3 text-[14px] text-fg transition-colors duration-120 outline-none placeholder:text-fg-subtle",
        "focus:border-accent focus:ring-[3px] focus:ring-accent-wash",
        "aria-invalid:border-danger",
        "disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}

export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-2", className)}>
      <label className="text-[13px] font-medium text-fg-muted" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-[13px] text-danger-text">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[13px] text-fg-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "min-h-24 w-full rounded-md border border-line-strong bg-bg px-3 py-2.5 text-[14px] text-fg transition-colors duration-120 outline-none placeholder:text-fg-subtle",
        "focus:border-accent focus:ring-[3px] focus:ring-accent-wash",
        "aria-invalid:border-danger",
        className,
      )}
      {...props}
    />
  );
}
