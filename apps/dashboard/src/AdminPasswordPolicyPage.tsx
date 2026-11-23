import { useState, type ReactNode } from "react";

import { AdminShell } from "@/components/app/admin-shell.tsx";
import { PageHeader } from "@/components/app/app-shell.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Eyebrow } from "@/components/ui/eyebrow.tsx";
import { Field, Input } from "@/components/ui/input.tsx";
import { Segmented, SegmentedItem } from "@/components/ui/segmented.tsx";
import { TextLink } from "@/components/ui/text-link.tsx";
import {
  MINIMUM_LENGTH_CEILING,
  MINIMUM_LENGTH_FLOOR,
  POLICY_RULES,
  draftFromPolicy,
  policySummary,
  readPasswordPolicyConfiguration,
  savePasswordPolicy,
  type PasswordPolicyDraft,
} from "./admin-password-policy-client.ts";
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

export default function AdminPasswordPolicyPage() {
  const policy = useAdminConfiguration(queryKeys.admin.passwordPolicy, () => readPasswordPolicyConfiguration());
  const configuration = policy.value;
  const setConfiguration = policy.setValue;
  const load = policy.gate;
  const setLoad = policy.setGate;
  const [draft, setDraft] = useState<PasswordPolicyDraft | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  if (configuration !== null && draft === null) setDraft(draftFromPolicy(configuration.policy));

  const save = async () => {
    if (busy || configuration === null || draft === null) return;
    setBusy(true);
    setError("");
    setNotice("");
    const result = await savePasswordPolicy(draft, configuration.revision);
    setBusy(false);
    if (result.ok) {
      setConfiguration(result.value);
      setDraft(draftFromPolicy(result.value.policy));
      setNotice(`Saved. ${policySummary(result.value.policy)}`);
      return;
    }
    if (result.signInRequired) {
      setLoad({ kind: "refused", message: result.error, signInRequired: true });
      return;
    }
    if (result.conflict && result.refreshed !== null) {
      setConfiguration(result.refreshed);
      setDraft(draftFromPolicy(result.refreshed.policy));
    }
    setError(result.error);
  };

  if (configuration === null || draft === null) return <AdminShell section="password-policy" gate={load} />;

  return (
    <AdminShell section="password-policy" gate={load}>
      <section className="grid w-full max-w-[780px] gap-[18px] px-7 pt-[30px] pb-10 max-[760px]:px-4 max-[760px]:pt-[22px]">
        <div className="grid gap-1.5">
          <Eyebrow>Sign-in methods</Eyebrow>
          <PageHeader
            title="Password policy"
            lede="What a password must contain when it is set by a registration or a reset. Changing it never touches stored passwords."
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
        <Panel title="Minimum length">
          <Field
            label="Characters"
            htmlFor="policy-min-length"
            hint={`Between ${MINIMUM_LENGTH_FLOOR} and ${MINIMUM_LENGTH_CEILING}. A password that is already stored keeps working.`}
          >
            <Input
              id="policy-min-length"
              name="policy-min-length"
              type="number"
              inputMode="numeric"
              min={MINIMUM_LENGTH_FLOOR}
              max={MINIMUM_LENGTH_CEILING}
              value={draft.minLength}
              onChange={(event) => setDraft({ ...draft, minLength: event.target.value })}
              disabled={busy}
            />
          </Field>
        </Panel>
        <Panel title="Required characters">
          {POLICY_RULES.map((rule) => (
            <Row key={rule.name} label={rule.label}>
              <Segmented label={rule.label}>
                <SegmentedItem
                  pressed={draft[rule.name]}
                  disabled={busy}
                  onClick={() => setDraft({ ...draft, [rule.name]: true })}
                >
                  Required
                </SegmentedItem>
                <SegmentedItem
                  pressed={!draft[rule.name]}
                  disabled={busy}
                  onClick={() => setDraft({ ...draft, [rule.name]: false })}
                >
                  Not required
                </SegmentedItem>
              </Segmented>
            </Row>
          ))}
        </Panel>
        <Panel title="Saved configuration">
          <Row label="Revision">
            {configuration.revision === null ? "Not stored yet" : `Revision ${configuration.revision}`}
          </Row>
          <Row label="In effect">
            <span id="policy-summary">{policySummary(configuration.policy)}</span>
          </Row>
        </Panel>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save password policy"}
          </Button>
          <TextLink href="/">Back to your library</TextLink>
        </div>
      </section>
    </AdminShell>
  );
}
