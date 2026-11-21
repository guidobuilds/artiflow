import type { ComponentProps } from "react";

import { avatarSource } from "@artiflow/domain/avatars";

import { cn } from "@/lib/utils.ts";

export function Avatar({ size = "sm", className, ...props }: ComponentProps<"span"> & { size?: "sm" | "lg" }) {
  return (
    <span
      className={cn(
        "inline-grid flex-none place-items-center rounded-full bg-surface-3 font-semibold text-fg-muted ring-2 ring-bg",
        size === "sm" ? "size-7 text-[11px]" : "size-8 text-[11.5px]",
        className,
      )}
      {...props}
    />
  );
}

export function UserAvatar({
  image,
  size = "sm",
  className,
  ...props
}: Omit<ComponentProps<typeof Avatar>, "children"> & { image: string | null | undefined }) {
  return (
    <Avatar size={size} className={cn("overflow-hidden", className)} {...props}>
      <img src={avatarSource(image)} alt="" draggable={false} className="size-full object-cover" />
    </Avatar>
  );
}

export function AvatarGroup({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("inline-flex [&>*+*]:-ml-1", className)} {...props} />;
}
