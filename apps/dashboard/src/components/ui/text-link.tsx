import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.ts";

type TextLinkProps = ComponentProps<"button"> & { href?: string };

export function TextLink({ href, className, type, ...props }: TextLinkProps) {
  const classes = cn(
    "cursor-pointer border-b border-line-strong pb-px text-[13.5px] text-fg-muted transition-colors duration-120 hover:border-fg hover:text-fg",
    className,
  );
  if (href !== undefined) {
    return <a href={href} className={classes} {...(props as ComponentProps<"a">)} />;
  }
  return <button type={type ?? "button"} className={classes} {...props} />;
}
