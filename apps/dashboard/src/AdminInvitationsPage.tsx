import { useEffect, useState } from "react";

import { AdminShell } from "@/components/app/admin-shell.tsx";
import { PageHeader } from "@/components/app/app-shell.tsx";
import { TextLink } from "@/components/ui/text-link.tsx";
import { readAdminGate, type AdminGate } from "./admin-entry.ts";

const COMMANDS: { command: string; purpose: string }[] = [
  {
    command: "bun run user:invite EMAIL",
    purpose: "Print one single-use registration link for an address. It expires in 24 hours and never resets a password.",
  },
  {
    command: "bun run user:reset-password EMAIL",
    purpose: "Print one single-use password reset link for an existing account. It expires in one hour.",
  },
];

export default function AdminInvitationsPage() {
  const [gate, setGate] = useState<AdminGate>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    void readAdminGate().then((result) => {
      if (live) setGate(result);
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <AdminShell section="invitations" gate={gate}>
      <section className="grid w-full max-w-[780px] gap-[18px] px-7 pt-[30px] pb-10 max-[760px]:px-4 max-[760px]:pt-[22px]">
        <PageHeader
          title="Invitations"
          lede="One single-use link per person, shared outside Artiflow because this instance sends no email."
        />
        <section className="grid gap-4 rounded-lg border border-line bg-bg-raised p-5" aria-label="Current path">
          <p className="text-[14px] text-fg">
            Invitations are issued from the console today. Issuing, listing and revoking them here arrives in a later
            step, so nothing on this page creates an account and no link is hidden behind a control that cannot work.
          </p>
          {COMMANDS.map((entry) => (
            <div key={entry.command} className="grid gap-1.5">
              <code className="rounded-md bg-surface px-3 py-2 font-mono text-[13px] text-fg [overflow-wrap:anywhere]">
                {entry.command}
              </code>
              <p className="text-[13px] text-fg-muted">{entry.purpose}</p>
            </div>
          ))}
          <p className="text-[13px] text-fg-muted">
            Both commands print the link once. Nothing here stores it, and a completed invitation cannot be used twice.
          </p>
        </section>
        <TextLink href="/admin/users">Back to users</TextLink>
      </section>
    </AdminShell>
  );
}
