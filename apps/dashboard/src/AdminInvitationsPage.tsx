import { useEffect, useState } from "react";

import { AdminShell } from "@/components/app/admin-shell.tsx";
import { PageHeader } from "@/components/app/app-shell.tsx";
import { OneTimeLink } from "@/components/app/one-time-link.tsx";
import { Button, ButtonGroup } from "@/components/ui/button.tsx";
import { Field, Input } from "@/components/ui/input.tsx";
import { TextLink } from "@/components/ui/text-link.tsx";
import {
  EMPTY_INVITATION_READ,
  HIDDEN_LINK,
  applyInvitationRead,
  dayLabel,
  dismissLink,
  issueInvitation,
  issuedNotice,
  issuerLabel,
  readPendingInvitations,
  regenerateInvitation,
  regeneratedNotice,
  revokeInvitation,
  revokedNotice,
  revealInvitationLink,
  type AdminInvitation,
  type InvitationListRead,
  type LinkReveal,
} from "./admin-invitations-client.ts";
import type { AdminGate } from "./admin-entry.ts";

const LEDE =
  "One single-use link per person, shared outside Artiflow because this instance sends no email. A link appears once, on the call that creates it, and a reload loses it.";

function gateOf(read: InvitationListRead): AdminGate {
  if (read.invitations !== null) return { kind: "ready" };
  if (read.failure !== "") return { kind: "refused", message: read.failure, signInRequired: read.signInRequired };
  return { kind: "loading" };
}

export default function AdminInvitationsPage() {
  const [read, setRead] = useState<InvitationListRead>(EMPTY_INVITATION_READ);
  const [email, setEmail] = useState("");
  const [revision, setRevision] = useState(0);
  const [reveal, setReveal] = useState<LinkReveal>(HIDDEN_LINK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let live = true;
    void readPendingInvitations().then((result) => {
      if (!live) return;
      setRead((current) => applyInvitationRead(current, result));
    });
    return () => {
      live = false;
    };
  }, [revision]);

  const rows = read.invitations;
  const gate = gateOf(read);

  const issue = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const result = await issueInvitation(email);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setEmail("");
    setReveal(revealInvitationLink(result.value.link));
    setNotice(issuedNotice(result.value));
    setRevision((current) => current + 1);
  };

  const revoke = async (row: AdminInvitation) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const result = await revokeInvitation(row.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setNotice(revokedNotice(row.email));
    setRevision((current) => current + 1);
  };

  const regenerate = async (row: AdminInvitation) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const result = await regenerateInvitation(row.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setReveal(revealInvitationLink(result.value.link));
    setNotice(regeneratedNotice(result.value.invitation));
    setRevision((current) => current + 1);
  };

  return (
    <AdminShell section="invitations" gate={gate}>
      <section className="grid w-full max-w-[980px] gap-[18px] px-7 pt-[30px] pb-10 max-[760px]:px-4 max-[760px]:pt-[22px]">
        <PageHeader title="Invitations" lede={LEDE} />
        <section className="grid gap-4 rounded-lg border border-line bg-bg-raised p-5" aria-label="Invite someone">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Email" htmlFor="admin-invitation-email" className="min-w-[240px] flex-1">
              <Input
                id="admin-invitation-email"
                type="email"
                value={email}
                placeholder="person@example.com"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                onChange={(event) => setEmail(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void issue();
                }}
              />
            </Field>
            <Button variant="primary" disabled={busy} onClick={() => void issue()}>
              {busy ? "Issuing…" : "Issue invitation"}
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-[13px] text-danger-text">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="text-[13px] text-fg-muted">
              {notice}
            </p>
          ) : null}
          <OneTimeLink state={reveal} onDismiss={() => setReveal(dismissLink())} />
        </section>
        {rows !== null && read.failure !== "" ? (
          <div role="alert" className="grid gap-1 text-[13px] text-danger-text">
            <span>{read.failure}</span>
            <span>The list below is the last one that loaded, so it may no longer match the server.</span>
          </div>
        ) : null}
        {rows === null ? null : rows.length === 0 ? (
          <p className="text-[14px] text-fg-muted">
            No invitation is pending. Enter an address above to issue one; the console still prints the same kind of
            link with bun run user:invite EMAIL.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-bg-raised">
            <table className="w-full border-collapse text-left text-[13.5px]">
              <thead>
                <tr className="border-b border-line text-[12px] text-fg-subtle">
                  <th scope="col" className="px-4 py-2.5 font-normal">
                    Email
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-normal">
                    Issued by
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-normal">
                    Issued
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-normal">
                    Expires
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-normal">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-line last:border-b-0">
                    <td className="px-4 py-3 text-fg [overflow-wrap:anywhere]">{row.email}</td>
                    <td className="px-4 py-3 text-fg-muted">{issuerLabel(row.issuedBy)}</td>
                    <td className="px-4 py-3 text-fg-muted">{dayLabel(row.createdAt)}</td>
                    <td className="px-4 py-3 text-fg-muted">{dayLabel(row.expiresAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <ButtonGroup>
                        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void regenerate(row)}>
                          Regenerate
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void revoke(row)}>
                          Revoke
                        </Button>
                      </ButtonGroup>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[13px] text-fg-muted">
          A link is shown once, by the call that creates it. Nothing here stores it, and a completed invitation cannot
          be used twice.
        </p>
        <TextLink href="/admin/users">Back to users</TextLink>
      </section>
    </AdminShell>
  );
}
