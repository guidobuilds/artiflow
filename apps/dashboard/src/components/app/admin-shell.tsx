import type { ReactNode } from "react";

import {
  adminSectionLabel,
  adminSectionPath,
  ADMIN_SECTIONS,
  type AdminGate,
  type AdminSection,
} from "../../admin-entry.ts";
import { BareShell } from "@/components/app/app-shell.tsx";
import { buttonVariants } from "@/components/ui/button.tsx";
import { Eyebrow } from "@/components/ui/eyebrow.tsx";
import { cn } from "@/lib/utils.ts";

function AdminHeader({ section }: { section: AdminSection }) {
  return (
    <header className="shrink-0 border-b border-line px-[22px] pt-[18px] max-[760px]:px-4">
      <Eyebrow>Instance administration</Eyebrow>
      <nav aria-label="Administration" className="mt-2.5 flex gap-1">
        {ADMIN_SECTIONS.map((entry) => (
          <a
            key={entry.key}
            href={entry.href}
            aria-current={entry.key === section ? "page" : undefined}
            className={cn(
              "inline-flex h-9 items-center rounded-md px-3 text-[13.5px] no-underline transition-colors duration-120",
              entry.key === section ? "bg-hover font-medium text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
            )}
          >
            {entry.label}
          </a>
        ))}
      </nav>
    </header>
  );
}

export function AdminRefusal({ section, gate }: { section: AdminSection; gate: AdminGate }) {
  const signInRequired = gate.kind === "refused" && gate.signInRequired;
  const message = gate.kind === "refused" ? gate.message : "";
  const title = signInRequired ? "Sign in to open this page." : "This area is for administrators.";
  const signInHref = `/login?return=${encodeURIComponent(adminSectionPath(section))}`;

  return (
    <BareShell>
      <div className="grid flex-1 place-items-center px-4 py-10">
        <section className="grid w-full max-w-[620px] min-w-0 justify-items-start gap-3.5">
          <p className="font-mono text-[13px] text-fg-subtle">Administration · {adminSectionLabel(section)}</p>
          {gate.kind === "loading" ? (
            <p className="text-fg-muted">Checking whether this account can manage this instance…</p>
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
    </BareShell>
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
  return (
    <BareShell>
      <AdminHeader section={section} />
      {children}
    </BareShell>
  );
}
