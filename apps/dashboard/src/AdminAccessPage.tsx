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
import {
  ACCESS_PROVIDERS,
  REGISTRATION_NOTES,
  credentialStateLabel,
  draftFromConfiguration,
  enabledMethodsLabel,
  provenanceLabel,
  readAccessConfiguration,
  registrationEntries,
  saveAccessConfiguration,
  type AccessDraft,
  type AccessProviderDraft,
  type AccessProviderName,
} from "./admin-access-client.ts";
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

export default function AdminAccessPage() {
  const toast = useToast();
  const access = useAdminConfiguration(queryKeys.admin.access, () => readAccessConfiguration());
  const configuration = access.value;
  const setConfiguration = access.setValue;
  const load = access.gate;
  const setLoad = access.setGate;
  const [draft, setDraft] = useState<AccessDraft | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  if (configuration !== null && draft === null) setDraft(draftFromConfiguration(configuration));

  const setProvider = (name: AccessProviderName, patch: Partial<AccessProviderDraft>) => {
    setDraft((current) =>
      current === null
        ? current
        : {
            ...current,
            providers: {
              ...current.providers,
              [name]: { ...current.providers[name], ...patch },
            },
          },
    );
  };

  const save = async () => {
    if (busy || configuration === null || draft === null) return;
    setBusy(true);
    setError("");
    setNotice("");
    const result = await saveAccessConfiguration(draft, configuration.revision);
    setBusy(false);
    if (result.ok) {
      setConfiguration(result.value);
      setDraft(draftFromConfiguration(result.value));
      setNotice(`Saved. ${enabledMethodsLabel(result.value)}`);
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

  if (configuration === null || draft === null) return <AdminShell section="access" gate={load} />;

  return (
    <AdminShell section="access" gate={load}>
      <section className="grid w-full max-w-[780px] gap-[18px] px-7 pt-[30px] pb-10 max-[760px]:px-4 max-[760px]:pt-[22px]">
        <div className="grid gap-1.5">
          <Eyebrow>Sign-in methods</Eyebrow>
          <PageHeader
            title="Access methods"
            lede="How people sign in to this instance. Changes are applied without a restart."
          />
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
        <Panel title="Provider registration">
          <p className="text-[13px] text-fg-muted">
            Create the client at each provider first, then paste its values below. These addresses come from this
            instance's public origin, so they are shown whether or not a provider is enabled here.
          </p>
          {registrationEntries(configuration).map((entry) => (
            <div key={entry.id} className="grid gap-1.5">
              <span className="text-[13px] font-medium text-fg-muted">{entry.label}</span>
              <div className="flex min-w-0 gap-2">
                <p className="flex h-10 min-w-0 flex-1 items-center rounded-md border border-line bg-surface px-3 font-mono text-[12.5px] text-fg select-all">
                  <span className="truncate">{entry.value}</span>
                </p>
                <Button
                  onClick={() =>
                    void navigator.clipboard?.writeText(entry.value).then(
                      () => toast.toast(`${entry.label} copied`),
                      () => toast.toast("Copying failed. Select the address and copy it manually."),
                    )
                  }
                >
                  Copy
                </Button>
              </div>
              <span className="text-[13px] text-fg-muted">{entry.sentence}</span>
            </div>
          ))}
          {REGISTRATION_NOTES.map((note) => (
            <p key={note} className="text-[13px] text-fg-muted">
              {note}
            </p>
          ))}
        </Panel>
        <Panel title="Password">
          <Row label="Email and password sign-in">
            <Segmented label="Email and password sign-in">
              <SegmentedItem
                pressed={draft.passwordEnabled}
                disabled={busy}
                onClick={() => setDraft({ ...draft, passwordEnabled: true })}
              >
                Enabled
              </SegmentedItem>
              <SegmentedItem
                pressed={!draft.passwordEnabled}
                disabled={busy}
                onClick={() => setDraft({ ...draft, passwordEnabled: false })}
              >
                Disabled
              </SegmentedItem>
            </Segmented>
          </Row>
        </Panel>
        {ACCESS_PROVIDERS.map((provider) => (
          <Panel key={provider.name} title={provider.label}>
            <Row label={`${provider.label} sign-in`}>
              <Segmented label={`${provider.label} sign-in`}>
                <SegmentedItem
                  pressed={draft.providers[provider.name].enabled}
                  disabled={busy}
                  onClick={() => setProvider(provider.name, { enabled: true })}
                >
                  Enabled
                </SegmentedItem>
                <SegmentedItem
                  pressed={!draft.providers[provider.name].enabled}
                  disabled={busy}
                  onClick={() => setProvider(provider.name, { enabled: false })}
                >
                  Disabled
                </SegmentedItem>
              </Segmented>
            </Row>
            <Field label="Client id" htmlFor={`${provider.name}-client-id`}>
              <Input
                id={`${provider.name}-client-id`}
                name={`${provider.name}-client-id`}
                value={draft.providers[provider.name].clientId}
                onChange={(event) => setProvider(provider.name, { clientId: event.target.value })}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Row label="Stored credential">
              <Tag on={configuration.providers[provider.name].credentialConfigured}>
                {credentialStateLabel(configuration.providers[provider.name].credentialConfigured)}
              </Tag>
            </Row>
            <Field
              label="Replace credential"
              htmlFor={`${provider.name}-client-secret`}
              hint="Leave empty to keep the stored credential. A stored credential can be replaced, never read back."
            >
              <Input
                id={`${provider.name}-client-secret`}
                name={`${provider.name}-client-secret`}
                type="password"
                autoComplete="off"
                value={draft.providers[provider.name].clientSecret}
                onChange={(event) => setProvider(provider.name, { clientSecret: event.target.value })}
                disabled={busy}
              />
            </Field>
          </Panel>
        ))}
        <Panel title="Saved configuration">
          <Row label="Revision">
            {configuration.revision === null ? "Not stored yet" : `Revision ${configuration.revision}`}
          </Row>
          <Row label="Provenance">
            <span id="access-provenance">{provenanceLabel(configuration.provenance)}</span>
          </Row>
        </Panel>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save access methods"}
          </Button>
          <TextLink href="/admin/sso">Enterprise connection</TextLink>
          <TextLink href="/">Back to your library</TextLink>
        </div>
      </section>
    </AdminShell>
  );
}
