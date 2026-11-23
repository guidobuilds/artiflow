import { useState, type ReactNode } from "react";

import { AdminShell } from "@/components/app/admin-shell.tsx";
import { PageHeader } from "@/components/app/app-shell.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Eyebrow } from "@/components/ui/eyebrow.tsx";
import { Field, Input } from "@/components/ui/input.tsx";
import { Segmented, SegmentedItem } from "@/components/ui/segmented.tsx";
import { Tag } from "@/components/ui/tag.tsx";
import { TextLink } from "@/components/ui/text-link.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { credentialStateLabel } from "./admin-access-client.ts";
import {
  addDomain,
  connectionStateLabel,
  draftFromConfiguration,
  parseScopes,
  readinessStatement,
  readSsoConnectionConfiguration,
  removeDomain,
  saveSsoConnection,
  ssoProvenanceLabel,
  updateDomain,
  type SsoConnectionDraft,
} from "./admin-sso-client.ts";
import { useAdminConfiguration } from "./query/held.ts";
import { queryKeys } from "./query/keys.ts";

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

function Switch({
  label,
  on,
  onLabel,
  offLabel,
  disabled,
  onChange,
}: {
  label: string;
  on: boolean;
  onLabel: string;
  offLabel: string;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Segmented label={label}>
      <SegmentedItem pressed={on} disabled={disabled} onClick={() => onChange(true)}>
        {onLabel}
      </SegmentedItem>
      <SegmentedItem pressed={!on} disabled={disabled} onClick={() => onChange(false)}>
        {offLabel}
      </SegmentedItem>
    </Segmented>
  );
}

export default function AdminSsoPage() {
  const toast = useToast();
  const sso = useAdminConfiguration(queryKeys.adminSso, () => readSsoConnectionConfiguration());
  const configuration = sso.value;
  const setConfiguration = sso.setValue;
  const load = sso.gate;
  const setLoad = sso.setGate;
  const [draft, setDraft] = useState<SsoConnectionDraft | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  if (configuration !== null && draft === null) setDraft(draftFromConfiguration(configuration));

  const save = async () => {
    if (busy || configuration === null || draft === null) return;
    setBusy(true);
    setError("");
    setNotice("");
    const result = await saveSsoConnection(draft, configuration.revision);
    setBusy(false);
    if (result.ok) {
      setConfiguration(result.value);
      setDraft(draftFromConfiguration(result.value));
      setNotice(`Saved. The connection is ${connectionStateLabel(result.value.connection.enabled).toLowerCase()}.`);
      return;
    }
    if (result.signInRequired) {
      setLoad({ kind: "refused", message: result.error, signInRequired: true });
      return;
    }
    if (result.conflict && result.refreshed !== null) {
      setConfiguration(result.refreshed);
      setDraft(draftFromConfiguration(result.refreshed));
    }
    setError(result.error);
  };

  if (configuration === null || draft === null) return <AdminShell section="sso" gate={load} />;

  const readiness = readinessStatement(configuration.readiness);
  const setDraftField = (patch: Partial<SsoConnectionDraft>) => setDraft({ ...draft, ...patch });

  return (
    <AdminShell section="sso" gate={load}>
      <section className="grid w-full max-w-[780px] gap-[18px] px-7 pt-[30px] pb-10 max-[760px]:px-4 max-[760px]:pt-[22px]">
        <div className="grid gap-1.5">
          <Eyebrow>Sign-in methods</Eyebrow>
          <PageHeader
            title="Enterprise connection"
            lede="One OIDC connection for this instance. Nothing here is applied until it is saved, and the credential is never shown again once stored."
          />
        </div>
        {readiness ? (
          <p
            role="status"
            className="rounded-md border border-line-strong bg-surface px-4 py-3 text-[13px] text-fg-muted"
          >
            {readiness}
          </p>
        ) : null}
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
        <Panel title="Connection">
          <Row label="Connection state">
            <Switch
              label="Connection state"
              on={draft.enabled}
              onLabel="Enabled"
              offLabel="Disabled"
              disabled={busy}
              onChange={(next) => setDraftField({ enabled: next })}
            />
          </Row>
          <Field
            label="Display name"
            htmlFor="sso-display-name"
            hint="What people see on the sign-in page while the connection is enabled."
          >
            <Input
              id="sso-display-name"
              name="sso-display-name"
              value={draft.displayName}
              onChange={(event) => setDraftField({ displayName: event.target.value })}
              disabled={busy}
              autoComplete="off"
            />
          </Field>
          <Field
            label="Issuer"
            htmlFor="sso-issuer"
            hint="The https issuer of a single-tenant application registration, without placeholders."
          >
            <Input
              id="sso-issuer"
              name="sso-issuer"
              value={draft.issuer}
              onChange={(event) => setDraftField({ issuer: event.target.value })}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://login.example.com/tenant-id/v2.0"
            />
          </Field>
          <Field label="Client id" htmlFor="sso-client-id">
            <Input
              id="sso-client-id"
              name="sso-client-id"
              value={draft.clientId}
              onChange={(event) => setDraftField({ clientId: event.target.value })}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Row label="Stored credential">
            <Tag on={configuration.connection.credentialConfigured}>
              {credentialStateLabel(configuration.connection.credentialConfigured)}
            </Tag>
          </Row>
          <Field
            label="Replace client secret"
            htmlFor="sso-client-secret"
            hint="Leave empty to keep the stored credential. A stored credential can be replaced, never read back."
          >
            <Input
              id="sso-client-secret"
              name="sso-client-secret"
              type="password"
              autoComplete="off"
              value={draft.clientSecret}
              onChange={(event) => setDraftField({ clientSecret: event.target.value })}
              disabled={busy}
            />
          </Field>
          <Field label="Requested scopes" htmlFor="sso-scopes" hint="Separated by spaces or commas.">
            <Input
              id="sso-scopes"
              name="sso-scopes"
              value={draft.scopes}
              onChange={(event) => setDraftField({ scopes: event.target.value })}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Row label="Scopes requested">
            <span>{parseScopes(draft.scopes).join(", ") || "None"}</span>
          </Row>
        </Panel>
        <Panel title="Admission">
          <Row label="Just-in-time provisioning">
            <Switch
              label="Just-in-time provisioning"
              on={draft.jitProvisioning}
              onLabel="On"
              offLabel="Off"
              disabled={busy}
              onChange={(next) => setDraftField({ jitProvisioning: next })}
            />
          </Row>
          <p className="text-[13px] text-fg-muted">
            With provisioning on, the first authorized sign-in creates a member account. It never creates an
            administrator.
          </p>
          <div className="grid gap-2">
            <span className="text-[13px] font-medium text-fg-muted">Allowed domains</span>
            {draft.allowedDomains.length === 0 ? (
              <p className="text-[13px] text-fg-muted">
                No domain is allowed yet. People from any domain are refused unless you add one below.
              </p>
            ) : null}
            {draft.allowedDomains.map((domain, index) => (
              <div key={`sso-domain-${index}`} className="flex items-center gap-2">
                <Input
                  id={`sso-domain-${index}`}
                  name={`sso-domain-${index}`}
                  value={domain}
                  onChange={(event) =>
                    setDraftField({ allowedDomains: updateDomain(draft.allowedDomains, index, event.target.value) })
                  }
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="example.com"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setDraftField({ allowedDomains: removeDomain(draft.allowedDomains, index) })}
                >
                  Remove
                </Button>
              </div>
            ))}
            <div>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => setDraftField({ allowedDomains: addDomain(draft.allowedDomains) })}
              >
                Add domain
              </Button>
            </div>
          </div>
          <Row label="Accept any account">
            <Switch
              label="Accept any account"
              on={draft.acceptAnyAccount}
              onLabel="Accepted"
              offLabel="Domain list only"
              disabled={busy}
              onChange={(next) => setDraftField({ acceptAnyAccount: next })}
            />
          </Row>
          {draft.acceptAnyAccount ? (
            <p role="alert" className="text-[13px] text-danger-text">
              {configuration.connection.acceptAnyAccountWarning}
            </p>
          ) : null}
        </Panel>
        <Panel title="Identity provider registration">
          <p className="text-[13px] text-fg-muted">
            Register this address at your identity provider as the redirect URI of the application.
          </p>
          <div className="flex min-w-0 gap-2">
            <p className="flex h-10 min-w-0 flex-1 items-center rounded-md border border-line bg-surface px-3 font-mono text-[12.5px] text-fg select-all">
              <span className="truncate">{configuration.redirectUri}</span>
            </p>
            <Button
              onClick={() =>
                void navigator.clipboard?.writeText(configuration.redirectUri).then(
                  () => toast.toast("Redirect address copied"),
                  () => toast.toast("Copying failed. Select the address and copy it manually."),
                )
              }
            >
              Copy address
            </Button>
          </div>
        </Panel>
        <Panel title="Saved configuration">
          <Row label="Revision">
            {configuration.revision === null ? "Not stored yet" : `Revision ${configuration.revision}`}
          </Row>
          <Row label="State">
            <span id="sso-state">
              {configuration.connection.credentialConfigured
                ? connectionStateLabel(configuration.connection.enabled)
                : `${connectionStateLabel(configuration.connection.enabled)}, with no credential stored`}
            </span>
          </Row>
          <Row label="Provenance">
            <span id="sso-provenance">{ssoProvenanceLabel(configuration.provenance)}</span>
          </Row>
        </Panel>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save connection"}
          </Button>
          <TextLink href="/admin/access">Back to access methods</TextLink>
          <TextLink href="/">Back to your library</TextLink>
        </div>
      </section>
    </AdminShell>
  );
}
