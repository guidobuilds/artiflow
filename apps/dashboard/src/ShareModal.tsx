import { useCallback, useEffect, useState, type FormEvent } from "react";

import {
  HIDDEN_REVEAL,
  createLink,
  createShare,
  dismissToken,
  getSession,
  listLinks,
  listShares,
  revealToken,
  revokeLink,
  revokeShare,
  rotateLink,
  tokenNotice,
  type AuthUser,
  type PublicLinkRow,
  type ShareGrant,
  type TokenReveal,
} from "./auth-client.ts";
import { Button, ButtonGroup } from "@/components/ui/button.tsx";
import { Avatar } from "@/components/ui/avatar.tsx";
import { Dialog, DialogContent, DialogHead, DialogSection, DialogTitle } from "@/components/ui/dialog.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Input } from "@/components/ui/input.tsx";
import { TextLink } from "@/components/ui/text-link.tsx";
import { useToast } from "@/components/ui/toast.tsx";

type Rows<T> = { kind: "loading" } | { kind: "ready"; rows: T[] } | { kind: "error"; detail: string };

export default function ShareModal({
  artifactId,
  title,
  onClose,
}: {
  artifactId: string;
  title: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [owner, setOwner] = useState<AuthUser | null>(null);
  const [shares, setShares] = useState<Rows<ShareGrant>>({ kind: "loading" });
  const [links, setLinks] = useState<Rows<PublicLinkRow>>({ kind: "loading" });
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<TokenReveal>(HIDDEN_REVEAL);
  const [resetting, setResetting] = useState(false);

  const loadShares = useCallback(() => {
    void listShares(artifactId).then((result) => {
      setShares(result.ok ? { kind: "ready", rows: result.value } : { kind: "error", detail: result.error });
    });
  }, [artifactId]);

  const loadLinks = useCallback(() => {
    void listLinks(artifactId).then((result) => {
      setLinks(result.ok ? { kind: "ready", rows: result.value } : { kind: "error", detail: result.error });
    });
  }, [artifactId]);

  useEffect(() => {
    let cancelled = false;
    void getSession().then((result) => {
      if (!cancelled && result.ok) setOwner(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    loadShares();
    loadLinks();
  }, [loadShares, loadLinks]);

  const invite = (event: FormEvent) => {
    event.preventDefault();
    setBusy("invite");
    setError(null);
    void createShare(artifactId, email).then((result) => {
      setBusy(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEmail("");
      loadShares();
      toast.toast(`${email.trim()} can now view`);
    });
  };

  const removeGrant = (grant: ShareGrant) => {
    setBusy(grant.id);
    setError(null);
    void revokeShare(artifactId, grant.id).then((result) => {
      setBusy(null);
      if (!result.ok) setError(result.error);
      else {
        loadShares();
        toast.toast(`Removed ${grant.email}`);
      }
    });
  };

  const activeLink = links.kind === "ready" ? links.rows.find((link) => link.revokedLabel === null) : undefined;
  const publicOn = activeLink !== undefined;

  const turnOn = () => {
    setBusy("link");
    setError(null);
    void createLink(artifactId).then((result) => {
      setBusy(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setReveal(revealToken(result.value));
      loadLinks();
      toast.toast("Anyone with the link can view");
    });
  };

  const turnOff = () => {
    if (!activeLink) return;
    setBusy("link");
    setError(null);
    setResetting(false);
    void revokeLink(artifactId, activeLink.id).then((result) => {
      setBusy(null);
      if (!result.ok) setError(result.error);
      else {
        loadLinks();
        toast.toast("Link turned off");
      }
    });
  };

  const rotate = () => {
    if (!activeLink) return;
    setBusy("rotate");
    setError(null);
    void rotateLink(artifactId, activeLink.id).then((result) => {
      setBusy(null);
      if (!result.ok) setError(result.error);
      else setReveal(revealToken(result.value));
    });
  };

  const copy = (url: string) => {
    void navigator.clipboard?.writeText(url).then(
      () => toast.toast("Link copied"),
      () => toast.toast("Copying failed. Select the URL and copy it manually."),
    );
  };

  const notice = tokenNotice(reveal);
  const ownerSource = owner ? owner.name.trim() || owner.email : "";
  const ownerParts = ownerSource.split(/\s+/).filter(Boolean);
  const ownerInitials = (
    (ownerParts[0]?.[0] ?? "") + (ownerParts.length >= 2 ? (ownerParts[1]?.[0] ?? "") : (ownerSource[1] ?? ""))
  ).toUpperCase();

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined} className="max-w-[480px]">
        <DialogHead />
        <DialogTitle className="text-[18px]">Share “{title}”</DialogTitle>

        <DialogSection className="grid-cols-[minmax(0,1fr)] border-t-0 pt-4">
          <form className="grid gap-2" onSubmit={invite} noValidate>
            <label htmlFor="share-email" className="text-[13.5px] font-medium text-fg">
              Invite by email
            </label>
            <div className="flex gap-2">
              <Input
                id="share-email"
                className="flex-1"
                type="email"
                placeholder="name@company.com"
                autoComplete="off"
                value={email}
                aria-invalid={error ? true : undefined}
                aria-describedby="share-email-hint"
                onChange={(event) => {
                  setEmail(event.target.value);
                  if (error) setError(null);
                }}
                disabled={busy === "invite"}
              />
              <Button variant="primary" type="submit" disabled={busy === "invite" || email.trim() === ""}>
                {busy === "invite" ? "Sharing…" : "Share"}
              </Button>
            </div>
            <span id="share-email-hint" className="text-[12.5px] text-fg-subtle">
              They need an account on this server. They can read, not edit.
            </span>
          </form>
          {error ? (
            <p role="alert" className="text-[13px] text-danger-text">
              {error}
            </p>
          ) : null}

          {shares.kind === "loading" ? (
            <p className="text-[13px] text-fg-muted">Loading who can read this artifact…</p>
          ) : null}
          {shares.kind === "error" ? (
            <p role="alert" className="text-[13px] text-danger-text">
              {shares.detail}
            </p>
          ) : null}
          {shares.kind === "ready" ? (
            <div className="grid">
              <p id="share-people" className="pb-1.5 text-[12.5px] text-fg-subtle">
                People with access
              </p>
              <ul className="m-0 list-none p-0" aria-labelledby="share-people">
                <li className="flex min-h-[44px] items-center gap-2.5 border-t border-line py-2">
                  <Avatar aria-label="Your initials">{ownerInitials || "?"}</Avatar>
                  <span className="min-w-0 flex-1 truncate text-[14px] text-fg">You</span>
                  <span className="text-[12.5px] text-fg-subtle">Owner</span>
                </li>
                {shares.rows.map((grant) => (
                  <li className="flex min-h-[44px] items-center gap-2.5 border-t border-line py-2" key={grant.id}>
                    <Avatar>{grant.email.slice(0, 2).toUpperCase()}</Avatar>
                    <span className="min-w-0 flex-1 truncate text-[14px] text-fg" title={`Since ${grant.createdLabel}`}>
                      {grant.email}
                    </span>
                    <span className="text-[12.5px] text-fg-subtle">Reader</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove access for ${grant.email}`}
                      disabled={busy === grant.id}
                      onClick={() => removeGrant(grant)}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
                {shares.rows.length === 0 ? (
                  <li className="border-t border-line py-2.5 text-[13px] text-fg-muted">
                    Shared with nobody yet. Only you can read it.
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}
        </DialogSection>

        <DialogSection className="grid-cols-[minmax(0,1fr)] gap-2.5 pb-6">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13.5px] font-medium text-fg">Public link</span>
            <span className="text-[12.5px] text-fg-subtle">{publicOn ? "Anyone with it can read" : "Off"}</span>
          </div>

          {links.kind === "ready" && !publicOn ? (
            <div className="grid justify-items-start gap-2.5">
              <p className="text-[13px] text-fg-muted">Only the people above can open it.</p>
              <Button size="sm" onClick={turnOn} disabled={busy === "link"}>
                <Icon name="link" className="size-3.5" />
                {busy === "link" ? "Creating…" : "Create public link"}
              </Button>
            </div>
          ) : null}

          {publicOn && !notice ? (
            <div
              aria-label="Public link, hidden"
              className="flex h-10 items-center rounded-md border border-line bg-surface px-3 font-mono text-[12.5px] text-fg-muted"
            >
              <span className="truncate">{window.location.origin}/share/•••••••••••••••</span>
            </div>
          ) : null}

          {notice ? (
            <div role="status" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
              <div className="flex gap-2">
                <p className="flex h-10 min-w-0 flex-1 items-center rounded-md border border-line bg-surface px-3 font-mono text-[12.5px] text-fg select-all">
                  <span className="truncate">{notice.url}</span>
                </p>
                <Button onClick={() => copy(notice.url)}>Copy URL</Button>
              </div>
              <div className="flex items-start justify-between gap-3">
                <p className="text-[12.5px] text-fg-subtle">{notice.warning}</p>
                <Button variant="ghost" size="sm" onClick={() => setReveal(dismissToken())}>
                  Dismiss
                </Button>
              </div>
            </div>
          ) : null}

          {links.kind === "error" ? (
            <p role="alert" className="text-[13px] text-danger-text">
              {links.detail}
            </p>
          ) : null}

          {publicOn ? (
            resetting ? (
              <div
                role="alertdialog"
                aria-label="Rotate link"
                className="grid gap-3 rounded-md border border-line-strong p-3.5"
              >
                <span className="text-[13.5px] text-fg">
                  Rotate the link? The current URL stops working for everyone who has it.
                </span>
                <ButtonGroup className="justify-self-end">
                  <Button size="sm" onClick={() => setResetting(false)}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      setResetting(false);
                      rotate();
                    }}
                    disabled={busy === "rotate"}
                  >
                    {busy === "rotate" ? "Rotating…" : "Rotate link"}
                  </Button>
                </ButtonGroup>
              </div>
            ) : (
              <div className="grid gap-1.5">
                <div className="flex gap-4 text-[13px]">
                  <TextLink onClick={() => setResetting(true)}>Rotate link</TextLink>
                  <button
                    type="button"
                    onClick={turnOff}
                    disabled={busy === "link"}
                    className="cursor-pointer text-danger-text underline underline-offset-[3px] disabled:opacity-40"
                  >
                    {busy === "link" ? "Revoking…" : "Revoke link"}
                  </button>
                </div>
                <p className="text-[12.5px] text-fg-subtle">
                  Rotating gives a new link and stops the old one. The full link is shown only when it is created.
                </p>
              </div>
            )
          ) : null}
        </DialogSection>
      </DialogContent>
    </Dialog>
  );
}
