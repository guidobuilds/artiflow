import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import {
  completePasswordReset,
  previewPasswordReset,
  resetPasswordError,
  RESET_PASSWORD_MISMATCH,
  RESET_REFUSED,
  tokenFromFragment,
} from "./auth-client.ts";
import { Button } from "@/components/ui/button.tsx";
import { Field, Input } from "@/components/ui/input.tsx";
import { Logo } from "@/components/ui/logo.tsx";
import { PasswordPolicyNotice, usePasswordPolicyReading } from "@/components/ui/password-policy-notice.tsx";
import { TextLink } from "@/components/ui/text-link.tsx";

type State =
  { kind: "checking" } | { kind: "ready"; email: string } | { kind: "refused"; message: string } | { kind: "done" };

const INCOMPLETE_LINK = "This password reset link is incomplete. Open the full link the operator sent you.";

function Notice({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col px-[clamp(20px,5vw,64px)] py-8">
      <a href="/" className="self-start text-fg no-underline" aria-label="artiflow home">
        <Logo />
      </a>
      <div className="my-auto grid w-full max-w-[380px] gap-4 py-10">
        <h1 className="display text-[32px]">Choose a new password</h1>
        {children}
      </div>
    </main>
  );
}

export default function ResetPage({ hash = window.location.hash }: { hash?: string } = {}) {
  const [token] = useState(() => tokenFromFragment(hash));
  const policy = usePasswordPolicyReading();
  const [state, setState] = useState<State>(() =>
    token === null ? { kind: "refused", message: INCOMPLETE_LINK } : { kind: "checking" },
  );
  const [values, setValues] = useState({ password: "", confirmation: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);

  useEffect(() => {
    if (token === null) return;
    let live = true;
    void previewPasswordReset(token)
      .then((result) => {
        if (!live) return;
        setState(result.ok ? { kind: "ready", email: result.value.email } : { kind: "refused", message: result.error });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [token]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current || token === null) return;
    setError("");
    const problem = resetPasswordError(values.password, values.confirmation);
    if (problem === RESET_PASSWORD_MISMATCH) {
      setError(problem);
      return;
    }
    submitting.current = true;
    setBusy(true);
    const completed = await completePasswordReset(token, values.password);
    setValues({ password: "", confirmation: "" });
    if (completed.ok) {
      setState({ kind: "done" });
      return;
    }
    if (completed.error === RESET_REFUSED) {
      setState({ kind: "refused", message: completed.error });
      return;
    }
    setError(completed.error);
    submitting.current = false;
    setBusy(false);
  };

  if (state.kind === "checking") {
    return (
      <Notice>
        <p className="text-fg-muted">Checking this password reset link…</p>
      </Notice>
    );
  }

  if (state.kind === "refused") {
    return (
      <Notice>
        <p id="reset-error" role="alert" className="text-[13px] text-danger-text">
          {state.message}
        </p>
        <p className="text-[13px] text-fg-muted">
          Know your password? <TextLink href="/login">Sign in</TextLink>
        </p>
      </Notice>
    );
  }

  if (state.kind === "done") {
    return (
      <Notice>
        <h1 className="display text-[32px]">Password changed</h1>
        <p role="status" className="text-fg-muted">
          Your password was changed and every session that was open before now needs the new password.{" "}
          <TextLink href="/login">Go to sign in</TextLink>
        </p>
      </Notice>
    );
  }

  return (
    <main className="flex min-h-dvh flex-col px-[clamp(20px,5vw,64px)] py-8">
      <a href="/" className="self-start text-fg no-underline" aria-label="artiflow home">
        <Logo />
      </a>
      <div className="my-auto grid w-full max-w-[380px] gap-4 py-10">
        <div className="grid gap-1.5">
          <h1 className="display text-[32px]">Choose a new password</h1>
          <p className="text-fg-muted">
            This link changes the password of the account below. Afterwards you sign in with the new password.
          </p>
        </div>
        <div className="grid gap-2">
          <p className="text-[13px] font-medium text-fg-muted">Account</p>
          <p id="reset-email" className="text-[14px] break-all text-fg">
            {state.email}
          </p>
        </div>
        <form
          className="grid gap-4"
          onSubmit={submit}
          noValidate
          aria-busy={busy}
          aria-describedby={error ? "reset-error" : undefined}
        >
          <PasswordPolicyNotice reading={policy} />
          <Field label="New password" htmlFor="reset-password">
            <Input
              id="reset-password"
              name="new-password"
              type="password"
              autoComplete="new-password"
              value={values.password}
              onChange={(event) => setValues({ ...values, password: event.target.value })}
              disabled={busy}
              required
            />
          </Field>
          <Field label="Confirm new password" htmlFor="reset-confirmation">
            <Input
              id="reset-confirmation"
              name="confirm-password"
              type="password"
              autoComplete="new-password"
              value={values.confirmation}
              onChange={(event) => setValues({ ...values, confirmation: event.target.value })}
              disabled={busy}
              required
            />
          </Field>
          {error ? (
            <p id="reset-error" role="alert" className="text-[13px] text-danger-text">
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="primary" className="mt-1 w-full" disabled={busy}>
            Set new password
          </Button>
        </form>
      </div>
    </main>
  );
}
