import { useState } from "react";

import { signOut, type AuthUser } from "../../auth-client.ts";
import { useTheme } from "@/components/app/theme-provider.tsx";
import { Avatar, UserAvatar } from "@/components/ui/avatar.tsx";
import { cn } from "@/lib/utils.ts";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/menu.tsx";

export function AccountMenu({ user, active }: { user: AuthUser | null; active?: boolean }) {
  const { theme, setTheme } = useTheme();
  const [busy, setBusy] = useState(false);
  const nextTheme = theme === "dark" ? "light" : "dark";
  return (
    <Menu
      width={224}
      align="end"
      wrapClassName="w-full"
      trigger={
        <button
          type="button"
          aria-label="Account"
          aria-current={active ? "page" : undefined}
          className={cn(
            "flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-sm p-1.5 text-left transition-colors duration-120",
            active ? "bg-surface-2 shadow-[inset_0_0_0_1px_var(--line)]" : "hover:bg-surface",
          )}
        >
          {user ? <UserAvatar image={user.image} name={user.name} className="ring-0" /> : <Avatar className="ring-0">?</Avatar>}
          <span className="grid min-w-0 leading-tight max-[760px]:hidden">
            <span className="truncate text-[13px] text-fg">{user ? user.name.trim() || user.email : "Account"}</span>
            {user && user.name.trim() ? (
              <span className="truncate text-[11.5px] text-fg-subtle">{user.email}</span>
            ) : null}
          </span>
        </button>
      }
    >
      {user ? (
        <MenuItem icon="users" onClick={() => window.location.assign("/account")}>
          Account
        </MenuItem>
      ) : null}
      <MenuItem icon="moon" onClick={() => setTheme(nextTheme)}>
        {nextTheme === "dark" ? "Dark theme" : "Light theme"}
      </MenuItem>
      {user ? (
        <>
          <MenuSeparator />
          <MenuItem
            icon="out"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void signOut().then(() => {
                window.location.assign("/login");
              });
            }}
          >
            {busy ? "Signing out…" : "Sign out"}
          </MenuItem>
        </>
      ) : null}
    </Menu>
  );
}
