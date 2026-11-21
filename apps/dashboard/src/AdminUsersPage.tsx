import { useEffect, useState, type ReactNode } from "react";

import { AdminShell } from "@/components/app/admin-shell.tsx";
import { AccountSessionsPanel } from "@/components/app/account-sessions.tsx";
import { PageHeader } from "@/components/app/app-shell.tsx";
import { OneTimeLink } from "@/components/app/one-time-link.tsx";
import { Button, ButtonGroup } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogFoot, DialogHead, DialogSection, DialogTitle } from "@/components/ui/dialog.tsx";
import { Field, Input } from "@/components/ui/input.tsx";
import { Segmented, SegmentedItem } from "@/components/ui/segmented.tsx";
import { Tag } from "@/components/ui/tag.tsx";
import { TextLink } from "@/components/ui/text-link.tsx";
import {
  HIDDEN_LINK,
  RESET_LINK_ACTIVE_ACCOUNT,
  dismissLink,
  issueResetLink,
  resetIssuedNotice,
  revealResetLink,
  type LinkReveal,
} from "./admin-invitations-client.ts";
import type { AdminGate } from "./admin-entry.ts";
import {
  ADMIN_USERS_PAGE_SIZE,
  EMPTY_DIRECTORY,
  accessMethodsLabel,
  applyDirectoryRead,
  changeAdminUserRole,
  directoryEmptyMessage,
  directorySummary,
  lastActivityLabel,
  nextStatus,
  readAdminUserPage,
  replaceAdminUserRole,
  replaceAdminUserRow,
  roleLabel,
  saveAdminUser,
  setAdminUserStatus,
  statusActionLabel,
  statusConfirmation,
  statusConfirmationTitle,
  statusLabel,
  type AdminRole,
  type AdminUserFilter,
  type AdminUserRow,
  type AdminUserStatus,
  type DirectoryRead,
} from "./admin-users-client.ts";

const FIRST_PAGE: AdminUserFilter = { page: 1, search: "", role: null, status: null };
const EMAIL_NOTICE =
  "No verification is required in this version: the new address takes effect immediately and the person keeps their linked sign-in methods.";

type Draft = { id: string; name: string; email: string };

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-bg-raised" aria-label={title}>
      <h2 className="border-b border-line px-5 py-3.5 text-[15px] font-semibold tracking-[-0.02em]">{title}</h2>
      <div className="grid gap-4 p-5">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
      <span className="text-[13px] text-fg-muted">{label}</span>
      <span className="min-w-0 text-[14px] [overflow-wrap:anywhere] text-fg">{children}</span>
    </div>
  );
}

function gateOf(directory: DirectoryRead): AdminGate {
  if (directory.page !== null) return { kind: "ready" };
  if (directory.failure !== "") return { kind: "refused", message: directory.failure, signInRequired: directory.signInRequired };
  return { kind: "loading" };
}

export default function AdminUsersPage() {
  const [directory, setDirectory] = useState<DirectoryRead>(EMPTY_DIRECTORY);
  const [filter, setFilter] = useState<AdminUserFilter>(FIRST_PAGE);
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editError, setEditError] = useState("");
  const [confirming, setConfirming] = useState<AdminUserStatus | null>(null);
  const [resetReveal, setResetReveal] = useState<LinkReveal>(HIDDEN_LINK);
  const [resetError, setResetError] = useState("");
  const [resetNotice, setResetNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);

  useEffect(() => {
    let live = true;
    void readAdminUserPage(filter).then((result) => {
      if (!live) return;
      setDirectory((current) => applyDirectoryRead(current, result));
    });
    return () => {
      live = false;
    };
  }, [filter, revision]);

  const rows = directory.page;
  const gate = gateOf(directory);
  const subject = draft === null || rows === null ? null : (rows.users.find((row) => row.id === draft.id) ?? null);

  const applySearch = () => setFilter((current) => ({ ...current, page: 1, search }));

  const clearFilters = () => {
    setSearch("");
    setFilter(FIRST_PAGE);
  };

  const openEditor = (row: AdminUserRow) => {
    setDraft({ id: row.id, name: row.name, email: row.email });
    setEditError("");
    setNotice("");
    setConfirming(null);
    setSessionsOpen(false);
    setResetReveal(dismissLink());
    setResetError("");
    setResetNotice("");
  };

  const closeEditor = () => {
    setDraft(null);
    setEditError("");
    setConfirming(null);
    setSessionsOpen(false);
    setResetReveal(dismissLink());
    setResetError("");
    setResetNotice("");
  };

  const issueReset = async () => {
    if (subject === null || busy) return;
    setBusy(true);
    setResetError("");
    setResetNotice("");
    const result = await issueResetLink(subject.email);
    setBusy(false);
    if (!result.ok) {
      setResetReveal(dismissLink());
      setResetError(result.error);
      return;
    }
    setResetReveal(revealResetLink(result.value.link));
    setResetNotice(resetIssuedNotice(subject.email, result.value.expiresAt));
  };

  const save = async () => {
    if (draft === null || busy) return;
    setBusy(true);
    setEditError("");
    setNotice("");
    const result = await saveAdminUser(draft.id, { name: draft.name, email: draft.email });
    setBusy(false);
    if (!result.ok) {
      setEditError(result.error);
      return;
    }
    setDirectory((current) =>
      current.page === null ? current : { ...current, page: replaceAdminUserRow(current.page, result.value) },
    );
    setDraft(null);
    setNotice(`Saved ${result.value.name.trim() || result.value.email}. The row above shows the stored values.`);
  };

  const changeRole = async (role: AdminRole) => {
    if (subject === null || busy || subject.role === role) return;
    setBusy(true);
    setEditError("");
    setNotice("");
    const result = await changeAdminUserRole(subject.id, role);
    setBusy(false);
    if (!result.ok) {
      setEditError(result.error);
      return;
    }
    const { id, role: stored, changed } = result.value;
    setDirectory((current) =>
      current.page === null ? current : { ...current, page: replaceAdminUserRole(current.page, id, stored) },
    );
    setNotice(changed ? `Role changed to ${roleLabel(stored)}.` : `That account already had the ${roleLabel(stored)} role.`);
  };

  const chooseStatus = (status: AdminUserStatus) => {
    setConfirming(status);
    setEditError("");
    setNotice("");
  };

  const applyStatus = async (status: AdminUserStatus) => {
    if (subject === null || busy) return;
    setBusy(true);
    setEditError("");
    setNotice("");
    const who = subject.name.trim() || subject.email;
    const result = await setAdminUserStatus(subject.id, status);
    setBusy(false);
    setConfirming(null);
    if (!result.ok) {
      setEditError(result.error);
      return;
    }
    setNotice(
      status === "deactivated"
        ? `Deactivated ${who}. Sign-in is closed, the open sessions ended and the public links are revoked. Nothing was deleted.`
        : `Reactivated ${who}. Sign-in works again; the sessions that ended and the revoked public links stay as they are.`,
    );
    setRevision((current) => current + 1);
  };

  const total = rows?.total ?? 0;
  const page = rows?.page ?? 1;
  const pageSize = rows?.pageSize ?? ADMIN_USERS_PAGE_SIZE;
  const filtered = filter.search.trim() !== "" || filter.role !== null || filter.status !== null;

  return (
    <AdminShell section="users" gate={gate}>
      <section className="grid w-full max-w-[980px] gap-[18px] px-7 pt-[30px] pb-10 max-[760px]:px-4 max-[760px]:pt-[22px]">
        <PageHeader
          title="Users"
          lede="Everyone who can sign in to this instance, how they sign in and when they last did."
        />
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Search accounts" htmlFor="admin-user-search" className="min-w-[220px] flex-1">
            <Input
              id="admin-user-search"
              value={search}
              placeholder="Name or email"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") applySearch();
              }}
            />
          </Field>
          <Segmented label="Role filter">
            <SegmentedItem
              pressed={filter.role === null}
              onClick={() => setFilter((current) => ({ ...current, page: 1, role: null }))}
            >
              All roles
            </SegmentedItem>
            <SegmentedItem
              pressed={filter.role === "member"}
              onClick={() => setFilter((current) => ({ ...current, page: 1, role: "member" }))}
            >
              Members
            </SegmentedItem>
            <SegmentedItem
              pressed={filter.role === "administrator"}
              onClick={() => setFilter((current) => ({ ...current, page: 1, role: "administrator" }))}
            >
              Administrators
            </SegmentedItem>
          </Segmented>
          <Segmented label="Status filter">
            <SegmentedItem
              pressed={filter.status === null}
              onClick={() => setFilter((current) => ({ ...current, page: 1, status: null }))}
            >
              Any status
            </SegmentedItem>
            <SegmentedItem
              pressed={filter.status === "active"}
              onClick={() => setFilter((current) => ({ ...current, page: 1, status: "active" }))}
            >
              Active
            </SegmentedItem>
            <SegmentedItem
              pressed={filter.status === "deactivated"}
              onClick={() => setFilter((current) => ({ ...current, page: 1, status: "deactivated" }))}
            >
              Deactivated
            </SegmentedItem>
          </Segmented>
          <Button onClick={applySearch}>Search</Button>
        </div>
        {notice ? (
          <p role="status" className="text-[13px] text-fg-muted">
            {notice}
          </p>
        ) : null}
        {rows !== null && directory.failure !== "" ? (
          <div role="alert" className="grid gap-1 text-[13px] text-danger-text">
            <span>{directory.failure}</span>
            <span>The table below is the last page that loaded, so it may no longer match the server.</span>
          </div>
        ) : null}
        {rows === null ? null : rows.users.length === 0 ? (
          <Panel title="No accounts on this page">
            <p className="text-[14px] text-fg-muted">{directoryEmptyMessage(filter)}</p>
            {filtered ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" onClick={clearFilters}>
                  Clear search and filters
                </Button>
              </div>
            ) : null}
          </Panel>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-bg-raised">
            <table className="w-full border-collapse text-left text-[13.5px]">
              <thead>
                <tr className="border-b border-line text-[12px] text-fg-subtle">
                  <th scope="col" className="px-4 py-2.5 font-normal">
                    Name
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-normal">
                    Email
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-normal">
                    Role
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-normal">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-normal">
                    Access methods
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-normal">
                    Last activity
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-normal">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.users.map((row) => (
                  <tr key={row.id} className="border-b border-line last:border-b-0">
                    <td className="px-4 py-3 text-fg [overflow-wrap:anywhere]">{row.name.trim() || "No name"}</td>
                    <td className="px-4 py-3 text-fg-muted [overflow-wrap:anywhere]">{row.email}</td>
                    <td className="px-4 py-3">
                      <Tag on={row.role === "administrator"}>{roleLabel(row.role)}</Tag>
                    </td>
                    <td className="px-4 py-3">
                      <Tag on={row.status === "active"}>{statusLabel(row.status)}</Tag>
                    </td>
                    <td className="px-4 py-3 text-fg-muted">{accessMethodsLabel(row.accessMethods)}</td>
                    <td className="px-4 py-3 text-fg-muted">{lastActivityLabel(row.lastActivityAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => openEditor(row)}>
                        Edit
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows !== null && total > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13px] text-fg-muted">{directorySummary(rows)}</p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={page <= 1}
                onClick={() => setFilter((current) => ({ ...current, page: Math.max(1, page - 1) }))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={page * pageSize >= total}
                onClick={() => setFilter((current) => ({ ...current, page: page + 1 }))}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
        {draft === null || subject === null ? null : (
          <Panel title={`Edit ${subject.name.trim() || subject.email}`}>
            {editError ? (
              <p role="alert" className="text-[13px] text-danger-text">
                {editError}
              </p>
            ) : null}
            <Field label="Name" htmlFor="admin-edit-name">
              <Input
                id="admin-edit-name"
                value={draft.name}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </Field>
            <Field label="Email" htmlFor="admin-edit-email" hint={EMAIL_NOTICE}>
              <Input
                id="admin-edit-email"
                type="email"
                value={draft.email}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                onChange={(event) => setDraft({ ...draft, email: event.target.value })}
              />
            </Field>
            <Row label="Role">
              <Segmented label="Role">
                <SegmentedItem
                  pressed={subject.role === "member"}
                  disabled={busy}
                  onClick={() => void changeRole("member")}
                >
                  Member
                </SegmentedItem>
                <SegmentedItem
                  pressed={subject.role === "administrator"}
                  disabled={busy}
                  onClick={() => void changeRole("administrator")}
                >
                  Administrator
                </SegmentedItem>
              </Segmented>
            </Row>
            <Row label="Lifecycle">
              <ButtonGroup>
                <Tag on={subject.status === "active"}>{statusLabel(subject.status)}</Tag>
                <Button
                  size="sm"
                  variant={subject.status === "active" ? "danger" : "secondary"}
                  disabled={busy}
                  onClick={() => chooseStatus(nextStatus(subject.status))}
                >
                  {statusActionLabel(nextStatus(subject.status))}
                </Button>
              </ButtonGroup>
            </Row>
            <Row label="Password reset">
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void issueReset()}>
                Issue reset link
              </Button>
            </Row>
            <Row label="Sessions">
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => setSessionsOpen((open) => !open)}
              >
                {sessionsOpen ? "Hide sessions" : "Open sessions"}
              </Button>
            </Row>
            {sessionsOpen ? (
              <AccountSessionsPanel userId={subject.id} who={subject.name.trim() || subject.email} />
            ) : null}
            <p className="text-[13px] text-fg-muted">{RESET_LINK_ACTIVE_ACCOUNT}</p>
            {resetError ? (
              <p role="alert" className="text-[13px] text-danger-text">
                {resetError}
              </p>
            ) : null}
            {resetNotice ? (
              <p role="status" className="text-[13px] text-fg-muted">
                {resetNotice}
              </p>
            ) : null}
            <OneTimeLink state={resetReveal} onDismiss={() => setResetReveal(dismissLink())} />
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" disabled={busy} onClick={() => void save()}>
                {busy ? "Saving…" : "Save changes"}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={closeEditor}>
                Cancel
              </Button>
            </div>
          </Panel>
        )}
        {confirming === null || subject === null ? null : (
          <Dialog open onOpenChange={(open) => !open && setConfirming(null)}>
            <DialogContent size="sm" aria-describedby={undefined}>
              <DialogHead />
              <DialogTitle>{statusConfirmationTitle(subject.name.trim() || subject.email, confirming)}</DialogTitle>
              <DialogSection className="border-t-0">
                <p className="m-0 text-[14px] text-fg-muted">{statusConfirmation(confirming)}</p>
              </DialogSection>
              <DialogFoot className="justify-end">
                <ButtonGroup>
                  <Button variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>
                    Cancel
                  </Button>
                  <Button
                    variant={confirming === "deactivated" ? "danger" : "primary"}
                    disabled={busy}
                    onClick={() => void applyStatus(confirming)}
                  >
                    {busy ? "Saving…" : statusActionLabel(confirming)}
                  </Button>
                </ButtonGroup>
              </DialogFoot>
            </DialogContent>
          </Dialog>
        )}
        <TextLink href="/admin/access">Go to access methods</TextLink>
      </section>
    </AdminShell>
  );
}
