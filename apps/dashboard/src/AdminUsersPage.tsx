import { useEffect, useState, type ReactNode } from "react";

import { AdminShell } from "@/components/app/admin-shell.tsx";
import { PageHeader } from "@/components/app/app-shell.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Field, Input } from "@/components/ui/input.tsx";
import { Segmented, SegmentedItem } from "@/components/ui/segmented.tsx";
import { Tag } from "@/components/ui/tag.tsx";
import { TextLink } from "@/components/ui/text-link.tsx";
import type { AdminGate } from "./admin-entry.ts";
import {
  ADMIN_USERS_PAGE_SIZE,
  accessMethodsLabel,
  changeAdminUserRole,
  directoryEmptyMessage,
  directorySummary,
  lastActivityLabel,
  readAdminUserPage,
  roleLabel,
  saveAdminUser,
  type AdminRole,
  type AdminUserFilter,
  type AdminUserPage,
  type AdminUserRow,
} from "./admin-users-client.ts";

const FIRST_PAGE: AdminUserFilter = { page: 1, search: "", role: null };
const EMAIL_NOTICE =
  "No verification is required in this version: the new address takes effect immediately and the person keeps their linked sign-in methods.";

type Draft = { id: string; name: string; email: string; role: AdminRole };

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

export default function AdminUsersPage() {
  const [gate, setGate] = useState<AdminGate>({ kind: "loading" });
  const [filter, setFilter] = useState<AdminUserFilter>(FIRST_PAGE);
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<AdminUserPage | null>(null);
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editError, setEditError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void readAdminUserPage(filter).then((result) => {
      if (!live) return;
      if (!result.ok) {
        setGate({ kind: "refused", message: result.error, signInRequired: result.signInRequired });
        return;
      }
      setRows(result.value);
      setGate({ kind: "ready" });
    });
    return () => {
      live = false;
    };
  }, [filter]);

  const applySearch = () => setFilter((current) => ({ ...current, page: 1, search }));

  const clearFilters = () => {
    setSearch("");
    setFilter(FIRST_PAGE);
  };

  const openEditor = (row: AdminUserRow) => {
    setDraft({ id: row.id, name: row.name, email: row.email, role: row.role });
    setEditError("");
    setNotice("");
  };

  const replaceRow = (row: AdminUserRow) =>
    setRows((current) =>
      current === null ? current : { ...current, users: current.users.map((entry) => (entry.id === row.id ? row : entry)) },
    );

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
    replaceRow(result.value);
    setDraft(null);
    setNotice(`Saved ${result.value.name.trim() || result.value.email}. The row above shows the stored values.`);
  };

  const changeRole = async (role: AdminRole) => {
    if (draft === null || busy || draft.role === role) return;
    setBusy(true);
    setEditError("");
    setNotice("");
    const result = await changeAdminUserRole(draft.id, role);
    setBusy(false);
    if (!result.ok) {
      setEditError(result.error);
      return;
    }
    const { id, role: stored, changed } = result.value;
    setDraft((current) => (current === null ? current : { ...current, role: stored }));
    setRows((current) =>
      current === null
        ? current
        : {
            ...current,
            users: current.users.map((entry) => (entry.id === id ? { ...entry, role: stored } : entry)),
          },
    );
    setNotice(changed ? `Role changed to ${roleLabel(stored)}.` : `That account already had the ${roleLabel(stored)} role.`);
  };

  const total = rows?.total ?? 0;
  const page = rows?.page ?? 1;
  const pageSize = rows?.pageSize ?? ADMIN_USERS_PAGE_SIZE;

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
          <Button onClick={applySearch}>Search</Button>
        </div>
        {notice ? (
          <p role="status" className="text-[13px] text-fg-muted">
            {notice}
          </p>
        ) : null}
        {rows === null ? null : rows.users.length === 0 ? (
          <Panel title="No accounts on this page">
            <p className="text-[14px] text-fg-muted">{directoryEmptyMessage({ search: filter.search, role: filter.role })}</p>
            {filter.search.trim() !== "" || filter.role !== null ? (
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
        {draft === null ? null : (
          <Panel title={`Edit ${draft.name.trim() || draft.email}`}>
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
                <SegmentedItem pressed={draft.role === "member"} disabled={busy} onClick={() => void changeRole("member")}>
                  Member
                </SegmentedItem>
                <SegmentedItem
                  pressed={draft.role === "administrator"}
                  disabled={busy}
                  onClick={() => void changeRole("administrator")}
                >
                  Administrator
                </SegmentedItem>
              </Segmented>
            </Row>
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" disabled={busy} onClick={() => void save()}>
                {busy ? "Saving…" : "Save changes"}
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setDraft(null);
                  setEditError("");
                }}
              >
                Cancel
              </Button>
            </div>
          </Panel>
        )}
        <TextLink href="/admin/access">Go to access methods</TextLink>
      </section>
    </AdminShell>
  );
}
