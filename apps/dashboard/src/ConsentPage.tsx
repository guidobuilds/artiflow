import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  describeScopes,
  followConsent,
  getPublicClient,
  parseConsentSearch,
  signOut,
  submitConsent,
  type PublicClient,
} from "./auth-client.ts";
import { queryKeys } from "./query/keys.ts";
import { loginHref } from "./route-guards.ts";
import { useSessionUser } from "./query/session.ts";
import { BareShell } from "@/components/app/app-shell.tsx";
import { AgentLogo, type AgentMarkName } from "@/components/ui/agent-logo.tsx";
import { UserAvatar } from "@/components/ui/avatar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Logo } from "@/components/ui/logo.tsx";

type State =
  | { kind: "fetching" }
  | { kind: "ready"; client: PublicClient }
  | { kind: "error"; detail: string; signInRequired: boolean }
  | { kind: "signing-in" }
  | { kind: "denied" }
  | { kind: "redirecting" };

const INVALID_LINK = "This consent link has no client identifier, so there is nothing to approve.";

function markFor(name: string): AgentMarkName | undefined {
  const lower = name.toLowerCase();
  if (lower.includes("claude")) return "claude";
  if (lower.includes("codex")) return "codex";
  if (lower.includes("opencode")) return "opencode";
  if (lower.includes("cursor")) return "cursor";
  return undefined;
}

function redirectTarget(oauthQuery: string): string | null {
  try {
    const url = new URL(new URLSearchParams(oauthQuery).get("redirect_uri") ?? "");
    return url.origin + url.pathname;
  } catch {
    return null;
  }
}

export default function ConsentPage({ search }: { search: string }) {
  const request = useMemo(() => parseConsentSearch(search), [search]);
  const clientQuery = useQuery({
    queryKey: queryKeys.auth.oauthClient(request?.clientId ?? ""),
    queryFn: () => getPublicClient(request?.clientId ?? ""),
    enabled: request !== null,
  });
  const loaded: State = !request
    ? { kind: "error", detail: INVALID_LINK, signInRequired: false }
    : clientQuery.isFetching || clientQuery.data === undefined
      ? { kind: "fetching" }
      : !clientQuery.data.ok && clientQuery.data.signInRequired
        ? { kind: "signing-in" }
        : clientQuery.data.ok
          ? { kind: "ready", client: clientQuery.data.value }
          : { kind: "error", detail: clientQuery.data.error, signInRequired: clientQuery.data.signInRequired };
  const [decision, setState] = useState<State | null>(null);
  const state = decision ?? loaded;
  const [busy, setBusy] = useState(false);
  const user = useSessionUser();
  const heading = useRef<HTMLHeadingElement>(null);
  const redirecting = useRef(false);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  const switchAccount = () => {
    setBusy(true);
    void signOut().then(() => window.location.assign(loginHref(window.location.pathname, window.location.search)));
  };

  useEffect(() => {
    if (state.kind !== "signing-in" || redirecting.current) return;
    redirecting.current = true;
    window.location.replace(loginHref(window.location.pathname, window.location.search));
  }, [state.kind]);

  const decide = async (accept: boolean) => {
    if (!request || busy) return;
    setBusy(true);
    const result = await submitConsent(accept, request.oauthQuery);
    setBusy(false);
    if (!result.ok) {
      setState({ kind: "error", detail: result.error, signInRequired: result.signInRequired });
      return;
    }
    setState({ kind: accept ? "redirecting" : "denied" });
    const followed = followConsent(result.url, window.location);
    if (!followed) {
      setState({
        kind: "error",
        detail: "The authorization server returned a redirect this browser cannot follow.",
        signInRequired: false,
      });
    }
  };

  const scopes = request ? describeScopes(request.scopes) : [];
  const target = request ? redirectTarget(request.oauthQuery) : null;
  const clientName = state.kind === "ready" ? state.client.clientName : "";
  if (state.kind === "signing-in") return null;

  return (
    <BareShell>
      <div className="grid min-h-0 flex-1 place-items-center px-4 py-10">
        <section
          data-consent-card=""
          className="grid w-full min-w-0 max-w-[440px] gap-[22px] rounded-[14px] border border-line bg-bg-raised p-7 max-sm:p-5"
          aria-labelledby="consent-heading"
          aria-busy={busy || state.kind === "fetching"}
        >
          <header className="grid gap-2.5">
            <div className="flex items-center gap-2.5 text-[13px] text-fg-muted">
              {state.kind === "ready" ? (
                <>
                  <AgentLogo
                    mark={markFor(clientName)}
                    letters={clientName.trim().slice(0, 2)}
                    className="size-8 rounded-md bg-surface"
                  />
                  <span className="min-w-0 truncate">{clientName}</span>
                  <Icon name="right" className="size-3.5 flex-none text-fg-subtle" />
                </>
              ) : null}
              <Logo withWordmark={false} className="text-fg" />
            </div>
            <h1
              id="consent-heading"
              ref={heading}
              tabIndex={-1}
              className="text-[26px] leading-[1.15] font-semibold tracking-[-0.035em] outline-none [overflow-wrap:anywhere]"
            >
              {state.kind === "ready" ? (
                <>{state.client.clientName} wants to use your artiflow account</>
              ) : (
                "Requested access"
              )}
            </h1>
          </header>

          {user ? (
            <div className="flex items-center gap-2.5 rounded-md bg-surface px-3 py-2.5 text-[13.5px]">
              <UserAvatar image={user.image} name={user.name} className="ring-0" />
              <span className="min-w-0 flex-1 truncate text-fg">{user.email}</span>
              <button
                type="button"
                onClick={switchAccount}
                disabled={busy}
                className="cursor-pointer text-[13px] text-fg-muted underline underline-offset-[3px] hover:text-fg disabled:cursor-not-allowed"
              >
                Switch account
              </button>
            </div>
          ) : null}

          {state.kind === "fetching" ? (
            <p className="text-[13px] text-fg-muted">Loading the requesting application&rsquo;s details…</p>
          ) : null}

          {state.kind === "error" ? (
            <div role="alert">
              <p className="text-[13px] text-danger-text">{state.detail}</p>
              <div className="mt-4">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setState(null);
                    void clientQuery.refetch();
                  }}
                >
                  Retry
                </Button>
              </div>
            </div>
          ) : null}

          {state.kind === "ready" ? (
            <div className="grid gap-[22px]">
              <div>
                <p className="mb-1 text-[13px] text-fg-muted">It will be able to</p>
                <ul className="m-0 list-none p-0">
                  {scopes.map((scope) => (
                    <li className="flex items-start gap-2.5 border-t border-line py-2" key={scope.token}>
                      <Icon name="check" className="mt-[3px] size-4 flex-none text-fg" />
                      <span className="min-w-0 flex-1 text-[14px] text-fg [overflow-wrap:anywhere]">{scope.label}</span>
                      <code className="pt-[3px] font-mono text-[11.5px] text-fg-subtle">{scope.token}</code>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="grid gap-3">
                <div data-consent-decisions="" className="grid grid-cols-2 gap-2.5">
                  <Button variant="secondary" onClick={() => void decide(false)} disabled={busy}>
                    Deny
                  </Button>
                  <Button variant="primary" onClick={() => void decide(true)} disabled={busy}>
                    {busy ? "Working…" : "Approve"}
                  </Button>
                </div>
                <p className="text-[12.5px] text-fg-subtle">
                  Either choice sends you back to{" "}
                  {target ? <span className="font-mono [overflow-wrap:anywhere]">{target}</span> : "the application"} so{" "}
                  {state.client.clientName} knows the answer.
                </p>
              </div>
              <details className="border-t border-line pt-3 text-fg-muted">
                <summary className="cursor-pointer py-1 text-[12.5px]">Request details</summary>
                <dl className="mt-3 grid gap-3 text-[12px]">
                  <div>
                    <dt className="caps">Client ID</dt>
                    <dd className="mt-1 break-all font-mono">{state.client.clientId}</dd>
                  </div>
                  {state.client.clientUri ? (
                    <div>
                      <dt className="caps">Application URL</dt>
                      <dd className="mt-1 break-all font-mono">{state.client.clientUri}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt className="caps">Resource</dt>
                    <dd className="mt-1 break-all font-mono">{request?.resource || "not stated in this request"}</dd>
                  </div>
                  <div>
                    <dt className="caps">Scopes</dt>
                    <dd className="mt-1 grid gap-1 break-all font-mono">
                      {scopes.map((scope) => (
                        <code key={scope.token}>{scope.token}</code>
                      ))}
                    </dd>
                  </div>
                </dl>
                <p className="mt-4 text-[12px]">
                  Approving records your decision for this application. Denying sends it an access_denied error and
                  grants nothing.
                </p>
              </details>
            </div>
          ) : null}

          {state.kind === "redirecting" ? (
            <p role="status" className="text-[13px] text-fg-muted">
              Approved. Returning you to the requesting application…
            </p>
          ) : null}
          {state.kind === "denied" ? (
            <p role="status" className="text-[13px] text-fg-muted">
              Denied. Returning you to the requesting application with an access_denied error…
            </p>
          ) : null}
        </section>
      </div>
    </BareShell>
  );
}
