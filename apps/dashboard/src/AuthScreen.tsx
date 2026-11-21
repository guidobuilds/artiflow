import { useEffect, useRef, useState, type FormEvent } from "react";

import { getCapabilities, signIn, signUp, socialSignIn } from "./auth-client.ts";
import { safeInternalPath } from "./lib/utils.ts";
import { Button } from "@/components/ui/button.tsx";
import { Field, Input } from "@/components/ui/input.tsx";
import { Logo } from "@/components/ui/logo.tsx";
import { PasswordPolicyNotice, type PasswordPolicyReading } from "@/components/ui/password-policy-notice.tsx";
import { Terminal, TerminalOutput, TerminalPrompt, TerminalTool } from "@/components/ui/terminal.tsx";
import { TextLink } from "@/components/ui/text-link.tsx";

function HowItWorks() {
  return (
    <aside
      aria-hidden="true"
      className="hidden min-w-0 flex-col justify-center gap-[22px] scope-feature border-l border-line p-[clamp(24px,5vw,64px)] min-[960px]:flex"
    >
      <p className="display max-w-[18ch] text-[clamp(24px,2.6vw,34px)] leading-[1.15]">
        Any agent. Your server. Every artifact.
      </p>
      <Terminal>
        <TerminalPrompt>Summarize the incident and publish it for the on-call team.</TerminalPrompt>
        <TerminalTool lit>artiflow · artifact_commit</TerminalTool>
        <TerminalOutput>Published &ldquo;API latency review&rdquo; · private · v1</TerminalOutput>
      </Terminal>
      <p className="text-[13px] text-fg-subtle">Self-hosted at {window.location.host}</p>
    </aside>
  );
}

export type InvitationMode = {
  email: string;
  created?: boolean;
  policy: PasswordPolicyReading;
  submit: (name: string, password: string) => Promise<{ error: string } | null>;
};

export default function AuthScreen({
  search = window.location.search,
  invitation,
}: { search?: string; invitation?: InvitationMode } = {}) {
  const returnPath = safeInternalPath(new URLSearchParams(search).get("return") ?? "") ?? "/";
  const [registrationAvailable, setRegistrationAvailable] = useState(false);
  const [socialProviders, setSocialProviders] = useState<string[]>([]);
  const [signup, setSignup] = useState(false);
  const [values, setValues] = useState({ name: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const newAccount = signup || invitation !== undefined;
  const created = invitation !== undefined && invitation.created === true;

  useEffect(() => {
    let live = true;
    void getCapabilities()
      .then((result) => {
        if (!live) return;
        setRegistrationAvailable(result.ok && result.value.registration === true);
        setSocialProviders(result.ok ? result.value.socialProviders : []);
      })
      .catch(() => {
      });
    return () => {
      live = false;
    };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current) return;
    setError("");
    const email = invitation !== undefined ? invitation.email : values.email.trim();
    if (invitation === undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Enter an email address like name@company.com.");
      return;
    }
    if (newAccount && invitation === undefined && values.password.length < 8) {
      setError("Passwords have at least 8 characters.");
      return;
    }
    submitting.current = true;
    setBusy(true);
    if (invitation !== undefined) {
      const answered = await invitation.submit(values.name.trim(), values.password);
      setValues((current) => ({ ...current, password: "" }));
      if (answered === null) return;
      setError(answered.error);
      submitting.current = false;
      setBusy(false);
      return;
    }
    const credentials = { email, password: values.password };
    const result = signup ? await signUp({ ...credentials, name: values.name.trim() }) : await signIn(credentials);
    setValues((current) => ({ ...current, password: "" }));
    if (result.ok) {
      window.location.assign(returnPath);
      return;
    }
    setError(result.error);
    submitting.current = false;
    setBusy(false);
  };

  const providerSignIn = async (provider: string) => {
    if (busy || submitting.current) return;
    setError("");
    setBusy(true);
    const result = await socialSignIn(provider, returnPath);
    if (result.ok) {
      window.location.assign(result.url);
      return;
    }
    setError(result.error);
    setBusy(false);
  };

  const label = newAccount ? "Create account" : "Sign in";
  return (
    <main className="grid min-h-dvh min-[960px]:grid-cols-2">
      <div className="flex min-w-0 flex-col px-[clamp(20px,5vw,64px)] py-8">
        <a href="/" className="self-start text-fg no-underline" aria-label="artiflow home">
          <Logo />
        </a>
        <div className="my-auto grid w-full max-w-[380px] gap-4 py-10">
          <div className="grid gap-1.5">
            <h1 className="display text-[32px]">
              {created ? "Account created" : newAccount ? "Create your account" : "Sign in"}
            </h1>
            <p className="text-fg-muted">
              {invitation !== undefined
                ? "This invitation fixes the email below. Choose a name and password to finish."
                : signup
                  ? "Your artifacts stay on this server."
                  : `Welcome back to ${window.location.host}.`}
            </p>
          </div>
          {invitation === undefined && socialProviders.length > 0 ? (
            <>
              <div className="grid gap-2.5">
                {socialProviders.map((provider) => (
                  <Button
                    key={provider}
                    type="button"
                    className="w-full"
                    disabled={busy}
                    onClick={() => void providerSignIn(provider)}
                  >
                    Continue with{" "}
                    {provider === "github" ? "GitHub" : provider.charAt(0).toUpperCase() + provider.slice(1)}
                  </Button>
                ))}
              </div>
              <p className="flex items-center gap-3 text-[12px] text-fg-subtle before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
                or with email
              </p>
            </>
          ) : null}
          {created ? (
            <div className="grid gap-3">
              <p role="status" className="text-fg-muted">
                Your account was created. Sign in with the password you just chose.
              </p>
              <TextLink href="/login">Go to sign in</TextLink>
            </div>
          ) : (
            <form
              className="grid gap-4"
              onSubmit={submit}
              noValidate
              aria-busy={busy}
              aria-describedby={error ? "auth-error" : undefined}
            >
              {newAccount ? (
                <Field label="Name" htmlFor="auth-name">
                  <Input
                    id="auth-name"
                    name="name"
                    autoComplete="name"
                    value={values.name}
                    onChange={(event) => setValues({ ...values, name: event.target.value })}
                    disabled={busy}
                    required
                  />
                </Field>
              ) : null}
              <Field label="Email" htmlFor="auth-email">
                <Input
                  id="auth-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@company.com"
                  value={invitation !== undefined ? invitation.email : values.email}
                  onChange={(event) => setValues({ ...values, email: event.target.value })}
                  disabled={busy}
                  readOnly={invitation !== undefined}
                  required
                />
              </Field>
              {invitation !== undefined ? <PasswordPolicyNotice reading={invitation.policy} /> : null}
              <Field label="Password" htmlFor="auth-password">
                <Input
                  id="auth-password"
                  name="password"
                  type="password"
                  placeholder={invitation === undefined ? "At least 8 characters" : undefined}
                  autoComplete={newAccount ? "new-password" : "current-password"}
                  value={values.password}
                  onChange={(event) => setValues({ ...values, password: event.target.value })}
                  disabled={busy}
                  required
                />
              </Field>
              {error ? (
                <p id="auth-error" role="alert" className="text-[13px] text-danger-text">
                  {error}
                </p>
              ) : null}
              <Button type="submit" variant="primary" className="mt-1 w-full" disabled={busy}>
                {label}
              </Button>
            </form>
          )}
          {registrationAvailable && invitation === undefined ? (
            <p className="text-[13px] text-fg-muted">
              {signup ? "Already have an account?" : "New here?"}{" "}
              <TextLink
                disabled={busy}
                onClick={() => {
                  setSignup((current) => !current);
                  setError("");
                  setValues((current) => ({ ...current, password: "" }));
                }}
              >
                {signup ? "Sign in" : "Create an account"}
              </TextLink>
            </p>
          ) : null}
        </div>
      </div>
      <HowItWorks />
    </main>
  );
}
