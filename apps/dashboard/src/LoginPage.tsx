import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  authorizeUrlFromQuery,
  continueAuthorization,
  FOLLOW_FAILED,
  followAuthorize,
  getCapabilities,
  getSession,
  signInWithOAuthQuery,
  ssoSignIn,
  type Continuation,
} from "./auth-client.ts";
import AuthScreen, { ConnectionPanel, EmergencyPanel } from "./AuthScreen.tsx";
import { queryKeys } from "./query/keys.ts";
import { BareShell } from "@/components/app/app-shell.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Field, Input } from "@/components/ui/input.tsx";
import {
  CONNECTION_ERROR_PATH_WITH_ALTERNATIVE,
  FALLBACK_PARAMETER,
  METHODS_UNAVAILABLE,
  loginSurface,
} from "./login-methods.ts";

type Status = "checking" | "signin" | "redirecting" | "invalid";

export default function LoginPage({ search }: { search: string }) {
  const link = useMemo(() => authorizeUrlFromQuery(search), [search]);
  const [status, setStatus] = useState<Status>(link ? "checking" : "invalid");
  const [values, setValues] = useState({ email: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [restartable, setRestartable] = useState(false);
  const capabilitiesQuery = useQuery({ queryKey: queryKeys.auth.capabilities, queryFn: () => getCapabilities() });
  const capabilities = capabilitiesQuery.data?.ok ? capabilitiesQuery.data.value : null;
  const readError = capabilitiesQuery.data && !capabilitiesQuery.data.ok ? METHODS_UNAVAILABLE : "";
  const heading = useRef<HTMLHeadingElement>(null);
  const surface = loginSurface(capabilities, search);
  const continuation = `${window.location.pathname}${window.location.search}`;
  const fallbackHref = useMemo(() => {
    const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
    params.set(FALLBACK_PARAMETER, "1");
    return `${window.location.pathname}?${params.toString()}`;
  }, [search]);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  const finish = (result: Continuation) => {
    if (!result.ok) {
      setError(result.error);
      setRestartable(result.restartable);
      return;
    }
    setStatus("redirecting");
    if (followAuthorize(result.url, window.location)) return;
    setStatus("signin");
    setError(FOLLOW_FAILED);
  };

  const authorization = useQuery({
    queryKey: queryKeys.auth.oauthResume(search),
    enabled: link !== null,
    staleTime: Infinity,
    queryFn: async () => {
      const session = await getSession();
      if (!session.ok) return { kind: "signin" as const, error: session.error, result: null };
      if (session.value === null) return { kind: "signin" as const, error: "", result: null };
      return { kind: "continuation" as const, error: "", result: await continueAuthorization(search) };
    },
  });
  useEffect(() => {
    const data = authorization.data;
    if (!data) return;
    if (data.kind === "signin") {
      setStatus("signin");
      if (data.error !== "") setError(data.error);
      return;
    }
    if (data.result && !data.result.ok) setStatus("signin");
    if (data.result) finish(data.result);
  }, [authorization.data]);

  const act = async (action: () => Promise<Continuation>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    const result = await action();
    setBusy(false);
    finish(result);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const credentials = { email: values.email.trim(), password: values.password };
    void act(async () => {
      const result = await signInWithOAuthQuery(credentials, search);
      setValues((current) => ({ ...current, password: "" }));
      return result;
    });
  };

  const onField = (key: "email" | "password") => (event: ChangeEvent<HTMLInputElement>) =>
    setValues((current) => ({ ...current, [key]: event.target.value }));

  const connectionSignIn = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    const result = await ssoSignIn(continuation, CONNECTION_ERROR_PATH_WITH_ALTERNATIVE);
    setBusy(false);
    if (result.ok) {
      window.location.assign(result.url);
      return;
    }
    setError(result.error);
  };

  if (!link) return <AuthScreen />;

  return (
    <BareShell>
      <div className="grid flex-1 place-items-center px-4 py-10">
        <section
          className="grid w-full max-w-[380px] min-w-0 gap-4"
          aria-labelledby="login-heading"
          aria-busy={busy || status === "checking"}
        >
          <div className="grid gap-1.5">
            <h1 id="login-heading" ref={heading} tabIndex={-1} className="display text-[32px] outline-none">
              Sign in to continue
            </h1>
            <p className="text-fg-muted">
              An application asked for access. Nothing is shared until you approve it on the next page.
            </p>
          </div>
          {status === "checking" || status === "redirecting" ? (
            <p role="status" className="text-[13px] text-fg-muted">
              {status === "checking" ? "Checking your account…" : "Continuing authorization…"}
            </p>
          ) : null}
          {status === "signin" ? (
            <div className="grid gap-4">
              {surface.connection ? (
                <ConnectionPanel
                  notice={surface.connection}
                  fallback={surface.fallbackLink}
                  fallbackHref={fallbackHref}
                  busy={busy}
                  start={() => void connectionSignIn()}
                />
              ) : null}
              {surface.emergency ? <EmergencyPanel notice={surface.emergency} /> : null}
              {readError ? (
                <p role="alert" className="text-[13px] text-danger-text">
                  {readError}
                </p>
              ) : null}
              {surface.password ? (
                <form className="grid gap-4" onSubmit={submit}>
                  <Field label="Email" htmlFor="login-email">
                    <Input
                      id="login-email"
                      type="email"
                      name="email"
                      autoComplete="email"
                      value={values.email}
                      onChange={onField("email")}
                      required
                      disabled={busy}
                    />
                  </Field>
                  <Field label="Password" htmlFor="login-password">
                    <Input
                      id="login-password"
                      type="password"
                      name="password"
                      autoComplete="current-password"
                      value={values.password}
                      onChange={onField("password")}
                      required
                      disabled={busy}
                    />
                  </Field>
                  <Button type="submit" variant="primary" className="mt-1 w-full" disabled={busy}>
                    {busy ? "Signing in…" : "Sign in and continue"}
                  </Button>
                </form>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <div role="alert">
              <p className="text-[13px] text-danger-text">{error}</p>
              {restartable ? (
                <div className="mt-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void act(() => continueAuthorization(search))}
                    disabled={busy}
                  >
                    {busy ? "Working…" : "Restart sign-in"}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </BareShell>
  );
}
