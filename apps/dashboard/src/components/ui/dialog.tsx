import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.ts";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  children,
  size,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { size?: "sm" | "md" }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-[fade-in_140ms_cubic-bezier(.2,.8,.2,1)]" />
      <DialogPrimitive.Content
        className={cn(
          "fixed inset-x-0 z-50 mx-auto flex max-h-[86dvh] w-[calc(100%-2rem)] flex-col overflow-hidden rounded-lg border border-line-strong bg-bg-raised shadow-floating",
          "top-[11dvh] max-w-[500px] data-[size=sm]:max-w-[440px]",
          "max-sm:top-auto max-sm:bottom-0 max-sm:w-full max-sm:max-w-full max-sm:rounded-b-none",
          "data-[state=open]:animate-[pop-in_150ms_cubic-bezier(.2,.8,.2,1)]",
          className,
        )}
        data-size={size}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHead({ className }: { className?: string }) {
  return (
    <DialogPrimitive.Close
      className={cn(
        "absolute top-3 right-3 z-10 grid size-8 cursor-pointer place-items-center rounded-sm text-fg-muted transition-colors duration-120 hover:bg-hover hover:text-fg",
        className,
      )}
      aria-label="Close"
    >
      <Icon name="x" />
    </DialogPrimitive.Close>
  );
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("display pt-[22px] pr-12 pl-[22px] text-[20px] leading-[1.2] [overflow-wrap:anywhere]", className)}
      {...props}
    />
  );
}

export function DialogDescription({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description className={cn("px-[22px] pb-5 text-[14px] text-fg-muted", className)} {...props} />
  );
}

export function DialogSection({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("grid gap-3.5 border-t border-line px-[22px] py-5", className)} {...props} />;
}

export function DialogFoot({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "mt-auto flex min-h-[52px] shrink-0 items-center justify-between gap-2.5 border-t border-line bg-bg px-[22px] py-2.5",
        className,
      )}
      {...props}
    />
  );
}

export function DialogNote({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-[12.5px] text-fg-subtle", className)} {...props} />;
}

export { Button as DialogButton };
