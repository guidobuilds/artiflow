import type { ReactNode } from "react";

import {
  adminSectionLabel,
  adminSectionPath,
  ADMIN_SECTION_GROUPS,
  ADMIN_SECTIONS,
  type AdminGate,
  type AdminSection,
} from "../../admin-entry.ts";
import { buttonVariants } from "@/components/ui/button.tsx";
import { Icon, type IconName } from "@/components/ui/icon.tsx";
import { Logo } from "@/components/ui/logo.tsx";
import { cn } from "@/lib/utils.ts";

const SECTION_ICONS: Record<AdminSection, IconName> = {
  users: "users",
  invitations: "mail",
  access: "key",
  sso: "shield",
  "password-policy": "lock",
};

function AdminNav({ section }: { section: AdminSection }) {
  return (
    <nav
      aria-label="Administration"
      className="mt-5 grid gap-4 max-[760px]:-mx-3 max-[760px]:mt-2 max-[760px]:flex max-[760px]:gap-1 max-[760px]:overflow-x-auto max-[760px]:px-3 max-[760px]:[scrollbar-width:none]"
    >
      {ADMIN_SECTION_GROUPS.map((group) => (
        <div key={group} className="grid gap-0.5 max-[760px]:contents">
          <p className="px-2.5 pb-1 text-[12px] text-fg-subtle max-[760px]:hidden">{group}</p>
          {ADMIN_SECTIONS.filter((entry) => entry.group === group).map((entry) => {
            const active = entry.key === section;
            return (
              <a
                key={entry.key}
                href={entry.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-w-0 items-start gap-2.5 rounded-md px-2.5 py-2 no-underline transition-colors duration-120",
                  "max-[760px]:shrink-0 max-[760px]:items-center max-[760px]:py-1.5",
                  active ? "bg-hover text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
                )}
              >
                <Icon name={SECTION_ICONS[entry.key]} className="mt-0.5 size-4 max-[760px]:mt-0" />
                <span className="grid min-w-0 gap-0.5">
                  <span className={cn("text-[13.5px] whitespace-nowrap", active && "font-medium")}>{entry.label}</span>
                  <span className="truncate text-[12px] text-fg-subtle max-[760px]:hidden">{entry.description}</span>
                </span>
              </a>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function AdminFrame({ section, children }: { section: AdminSection | null; children: ReactNode }) {
  return (
    <div className="grid min-h-dvh grid-cols-[minmax(0,1fr)] min-[761px]:grid-cols-[264px_minmax(0,1fr)]">
      <aside className="scope-side flex min-w-0 flex-col border-line px-3 py-4 min-[761px]:sticky min-[761px]:top-0 min-[761px]:h-dvh min-[761px]:overflow-y-auto min-[761px]:border-r max-[760px]:border-b max-[760px]:py-3">
        <div className="flex items-center justify-between gap-2 px-2 pb-3 max-[760px]:pb-1">
          <a
            href="/"
            className="text-fg no-underline transition-opacity duration-120 hover:opacity-80"
            aria-label="artiflow home"
          >
            <Logo />
          </a>
        </div>
        <a
          href="/"
          className="flex h-8 items-center gap-2 rounded-md px-2.5 text-[13px] text-fg-muted no-underline transition-colors duration-120 hover:bg-hover hover:text-fg max-[760px]:hidden"
        >
          <Icon name="left" className="size-3.5" />
          Back to library
        </a>
        <div className="mt-4 grid gap-0.5 px-2.5 max-[760px]:mt-1">
          <p className="text-[15px] font-semibold tracking-[-0.02em] text-fg">Administration</p>
          <p className="truncate font-mono text-[12px] text-fg-subtle max-[760px]:hidden">{window.location.host}</p>
        </div>
        {section ? <AdminNav section={section} /> : null}
      </aside>
      <main className="flex min-w-0 flex-col items-center">{children}</main>
    </div>
  );
}

export function AdminRefusal({ section, gate }: { section: AdminSection; gate: AdminGate }) {
  const signInRequired = gate.kind === "refused" && gate.signInRequired;
  const message = gate.kind === "refused" ? gate.message : "";
  const title = signInRequired ? "Sign in to open this page." : "This area is for administrators.";
  const signInHref = `/login?return=${encodeURIComponent(adminSectionPath(section))}`;

  return (
    <AdminFrame section={null}>
      <div className="grid w-full flex-1 place-items-center px-4 py-10">
        <section className="grid w-full max-w-[620px] min-w-0 justify-items-start gap-3.5">
          <p className="font-mono text-[13px] text-fg-subtle">Administration · {adminSectionLabel(section)}</p>
          {gate.kind === "loading" ? (
            <p role="status" className="text-fg-muted">
              Checking whether this account can manage this instance…
            </p>
          ) : (
            <>
              <h1 className="display text-[clamp(32px,5vw,52px)]">{title}</h1>
              <p role="alert" className="max-w-[52ch] text-[15px] text-danger-text">
                {message}
              </p>
              <p className="max-w-[52ch] text-[15px] text-fg-muted">
                Your library and shared artifacts stay available.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                {signInRequired ? (
                  <a
                    href={signInHref}
                    className={buttonVariants({ variant: "primary", className: "no-underline hover:opacity-90" })}
                  >
                    Sign in
                  </a>
                ) : null}
                <a
                  href="/"
                  className={buttonVariants({
                    variant: signInRequired ? "secondary" : "primary",
                    className: "no-underline hover:opacity-90",
                  })}
                >
                  Back to your library
                </a>
              </div>
            </>
          )}
        </section>
      </div>
    </AdminFrame>
  );
}

export function AdminPage({
  title,
  lede,
  action,
  wide = false,
  children,
}: {
  title: string;
  lede?: ReactNode;
  action?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "grid w-full gap-7 px-8 pt-8 pb-12 max-[760px]:px-4 max-[760px]:pt-[22px]",
        wide ? "max-w-[1040px]" : "max-w-[760px]",
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="grid min-w-0 gap-1.5">
          <h1 className="text-[24px] font-semibold tracking-[-0.035em]">{title}</h1>
          {lede ? <p className="max-w-[64ch] text-fg-muted">{lede}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function AdminShell({
  section,
  gate,
  children,
}: {
  section: AdminSection;
  gate: AdminGate;
  children?: ReactNode;
}) {
  if (gate.kind !== "ready") return <AdminRefusal section={section} gate={gate} />;
  return <AdminFrame section={section}>{children}</AdminFrame>;
}
