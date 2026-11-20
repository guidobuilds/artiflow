import { useEffect, useState, type ReactNode } from "react";

import { BareShell, PageHeader } from "@/components/app/app-shell.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Eyebrow } from "@/components/ui/eyebrow.tsx";
import { Field, Input } from "@/components/ui/input.tsx";
import { Segmented, SegmentedItem } from "@/components/ui/segmented.tsx";
import { Tag } from "@/components/ui/tag.tsx";
import { TextLink } from "@/components/ui/text-link.tsx";
import {
  ACCESS_PROVIDERS,
  credentialStateLabel,
  draftFromConfiguration,
  enabledMethodsLabel,
  provenanceLabel,
  readAccessConfiguration,
  saveAccessConfiguration,
  type AccessConfiguration,
  type AccessDraft,
  type AccessProviderDraft,
  type AccessProviderName,
} from "./admin-access-client.ts";

const RETURN_TO_PAGE = `/login?return=${encodeURIComponent("/admin/access")}`;

type Load = { kind: "loading" } | { kind: "ready" } | { kind: "refused"; message: string; signInRequired: boolean };

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
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [configuration, setConfiguration] = useState<AccessConfiguration | null>(null);
  const [draft, setDraft] = useState<AccessDraft | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void readAccessConfiguration().then((result) => {
      if (!live) return;
      if (!result.ok) {
        setLoad({ kind: "refused", message: result.error, signInRequired: result.signInRequired });
        return;
      }
      setConfiguration(result.value);
      setDraft(draftFromConfiguration(result.value));
      setLoad({ kind: "ready" });
    });
    return () => {
      live = false;
    };
  }, []);

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

  if (load.kind === "loading") {
    return (
      <BareShell>
        <div className="grid flex-1 place-items-center px-4 py-10">
          <p className="text-fg-muted">Checking whether this account can manage access methods…</p>
        </div>
      </BareShell>
    );
  }

  if (load.kind === "refused") {
    return (
      <BareShell>
        <div className="grid flex-1 place-items-center px-4 py-10">
          <section className="grid w-full max-w-[620px] min-w-0 justify-items-start gap-3.5">
            <p className="font-mono text-[13px] text-fg-subtle">Administration · Access methods</p>
            <h1 className="display text-[clamp(32px,5vw,52px)]">
              {load.signInRequired ? "Sign in to open this page." : "This area is for administrators."}
            </h1>
            <p role="alert" className="max-w-[52ch] text-[15px] text-danger-text">
              {load.message}
            </p>
            <p className="max-w-[52ch] text-[15px] text-fg-muted">
              Your library and shared artifacts stay available.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              {load.signInRequired ? (
                <a
                  href={RETURN_TO_PAGE}
                  className={buttonVariants({ variant: "primary", className: "no-underline hover:opacity-90" })}
                >
                  Sign in
                </a>
              ) : null}
              <a
                href="/"
                className={buttonVariants({
                  variant: load.signInRequired ? "secondary" : "primary",
                  className: "no-underline hover:opacity-90",
                })}
              >
                Back to your library
              </a>
            </div>
          </section>
        </div>
      </BareShell>
    );
  }

  if (configuration === null || draft === null) return null;

  return (
    <BareShell>
      <section className="grid w-full max-w-[780px] gap-[18px] px-7 pt-[30px] pb-10 max-[760px]:px-4 max-[760px]:pt-[22px]">
        <div className="grid gap-1.5">
          <Eyebrow>Instance administration</Eyebrow>
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
          <Row label="Revision">{configuration.revision === null ? "Not stored yet" : `Revision ${configuration.revision}`}</Row>
          <Row label="Provenance">
            <span id="access-provenance">{provenanceLabel(configuration.provenance)}</span>
          </Row>
        </Panel>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save access methods"}
          </Button>
          <TextLink href="/">Back to your library</TextLink>
        </div>
      </section>
    </BareShell>
  );
}
