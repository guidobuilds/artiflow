import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import AuthScreen from "./AuthScreen.tsx";
import { completeInvitation, INVITE_REFUSED, previewInvitation, signIn, tokenFromFragment } from "./auth-client.ts";
import { queryKeys } from "./query/keys.ts";
import { Logo } from "@/components/ui/logo.tsx";
import { usePasswordPolicyReading } from "@/components/ui/password-policy-notice.tsx";
import { TextLink } from "@/components/ui/text-link.tsx";

type State =
  | { kind: "checking" }
  | { kind: "ready"; email: string }
  | { kind: "refused"; message: string }
  | { kind: "created"; email: string };

const INCOMPLETE_LINK = "This invitation link is incomplete. Open the full link the operator sent you.";

function Notice({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col px-[clamp(20px,5vw,64px)] py-8">
      <a href="/" className="self-start text-fg no-underline" aria-label="artiflow home">
        <Logo />
      </a>
      <div className="my-auto grid w-full max-w-[380px] gap-4 py-10">
        <h1 className="display text-[32px]">Create your account</h1>
        {children}
      </div>
    </main>
  );
}

export default function RegisterPage({ hash = window.location.hash }: { hash?: string } = {}) {
  const [token] = useState(() => tokenFromFragment(hash));
  const policy = usePasswordPolicyReading();
  const preview = useQuery({
    queryKey: queryKeys.invitation(token ?? ""),
    queryFn: () => previewInvitation(token ?? ""),
    enabled: token !== null,
  });
  const [override, setState] = useState<State | null>(null);
  const loaded: State =
    token === null
      ? { kind: "refused", message: INCOMPLETE_LINK }
      : preview.data === undefined
        ? { kind: "checking" }
        : preview.data.ok
          ? { kind: "ready", email: preview.data.value.email }
          : { kind: "refused", message: preview.data.error };
  const state = override ?? loaded;

  const submit = async (name: string, password: string): Promise<{ error: string } | null> => {
    if (token === null) return { error: INCOMPLETE_LINK };
    const completed = await completeInvitation({ token, name, password });
    if (!completed.ok) {
      if (completed.error === INVITE_REFUSED) {
        setState({ kind: "refused", message: completed.error });
        return null;
      }
      return { error: completed.error };
    }
    if (state.kind !== "ready") return null;
    const { email } = state;
    setState({ kind: "created", email });
    const signed = await signIn({ email, password });
    if (signed.ok) window.location.assign("/");
    return null;
  };

  if (state.kind === "checking") {
    return (
      <Notice>
        <p className="text-fg-muted">Checking this invitation…</p>
      </Notice>
    );
  }

  if (state.kind === "refused") {
    return (
      <Notice>
        <p id="register-error" role="alert" className="text-[13px] text-danger-text">
          {state.message}
        </p>
        <p className="text-[13px] text-fg-muted">
          Already have an account? <TextLink href="/login">Sign in</TextLink>
        </p>
      </Notice>
    );
  }

  return (
    <AuthScreen
      invitation={{
        email: state.email,
        created: state.kind === "created",
        policy,
        submit,
      }}
    />
  );
}
