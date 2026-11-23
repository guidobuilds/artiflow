import { useEffect, useState, type ReactNode } from "react";

import { SessionRows } from "@/components/app/session-rows.tsx";
import { signOut } from "./auth-client.ts";
import { useSession } from "./query/session.ts";
import { AppShell, PageHeader } from "@/components/app/app-shell.tsx";
import { useTheme } from "@/components/app/theme-provider.tsx";
import { Button, ButtonGroup } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogFoot, DialogHead, DialogSection, DialogTitle } from "@/components/ui/dialog.tsx";
import { Segmented, SegmentedItem } from "@/components/ui/segmented.tsx";
import {
  EMPTY_SESSION_READ,
  LOGIN_PATH,
  applySessionRead,
  closeOtherSessionsConfirmation,
  closeOtherSessionsTitle,
  closeOwnSessionConfirmation,
  closeOwnSessionTitle,
  otherSessionsSummary,
  readOwnSessions,
  revokeOtherOwnSessions,
  revokeOwnSession,
  revokeOutcome,
  sessionsRevokedNotice,
  type SessionListRead,
  type SessionRow,
} from "./sessions-client.ts";

function Box({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-bg-raised" aria-label={title}>
      <h2 className="border-b border-line px-5 py-3.5 text-[15px] font-semibold tracking-[-0.02em]">{title}</h2>
      <div className="grid gap-3.5 p-5">{children}</div>
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

export default function AccountPage() {
  const { theme, setTheme } = useTheme();
  const session = useSession();
  const user = session.data?.ok ? session.data.value : null;
  const error = session.data && !session.data.ok ? session.data.error : "";
  const [busy, setBusy] = useState(false);
  const [read, setRead] = useState<SessionListRead>(EMPTY_SESSION_READ);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState("");
  const [confirming, setConfirming] = useState<SessionRow | "others" | null>(null);

  useEffect(() => {
    let live = true;
    void readOwnSessions().then((result) => {
      if (!live) return;
      setRead((current) => applySessionRead(current, result));
    });
    return () => {
      live = false;
    };
  }, [revision]);

  const sessions = read.sessions;
  const others = sessions === null ? [] : sessions.filter((row) => !row.current);

  const closeOne = async (row: SessionRow) => {
    if (busy) return;
    setBusy(true);
    setNotice("");
    const result = await revokeOwnSession(row.id);
    setBusy(false);
    setConfirming(null);
    if (!result.ok) {
      setNotice(result.error);
      setRevision((current) => current + 1);
      return;
    }
    if (revokeOutcome(row) === "signed_out") {
      window.location.assign(LOGIN_PATH);
      return;
    }
    setNotice("Closed one session. That browser needs to sign in again; this browser stays signed in.");
    setRevision((current) => current + 1);
  };

  const closeOthers = async () => {
    if (busy) return;
    setBusy(true);
    setNotice("");
    const result = await revokeOtherOwnSessions();
    setBusy(false);
    setConfirming(null);
    if (!result.ok) {
      setNotice(result.error);
      setRevision((current) => current + 1);
      return;
    }
    setNotice(sessionsRevokedNotice(result.value.revoked));
    setRevision((current) => current + 1);
  };

  return (
    <AppShell active="account" requireSession>
      <section className="grid w-full max-w-[780px] gap-[18px] px-7 pt-[30px] pb-10 max-[760px]:px-4 max-[760px]:pt-[22px]">
        <PageHeader title="Account" lede="Your profile, your sessions and how this browser shows artiflow." />
        {error ? (
          <p role="alert" className="text-[13px] text-danger-text">
            {error}
          </p>
        ) : null}
        {user ? (
          <Box title="Profile">
            <Row label="Name">{user.name.trim() || "Not set"}</Row>
            <Row label="Email">{user.email}</Row>
          </Box>
        ) : null}
        <Box title="Sessions">
          <p className="text-[13px] text-fg-muted">
            Every browser signed in as your account. The current one is marked; closing a session ends it now.
          </p>
          {read.failure ? (
            <div role="alert" className="grid gap-1 text-[13px] text-danger-text">
              <span>{read.failure}</span>
              <span>The list below is the last one that loaded, so it may no longer match the server.</span>
            </div>
          ) : null}
          {notice ? (
            <p role="status" className="text-[13px] text-fg-muted">
              {notice}
            </p>
          ) : null}
          {sessions === null ? (
            <p className="text-[13px] text-fg-muted">Reading the sessions of your account…</p>
          ) : sessions.length === 0 ? (
            <p className="text-[14px] text-fg-muted">
              No session is open. Signing in again creates one, and this list shows it.
            </p>
          ) : (
            <SessionRows
              sessions={sessions}
              currentLabel="This browser"
              action={(row) => (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(row)}>
                  Close
                </Button>
              )}
            />
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant="danger"
              disabled={busy || others.length === 0}
              onClick={() => setConfirming("others")}
            >
              {others.length === 0
                ? "Close other sessions"
                : `Close ${others.length} other session${others.length === 1 ? "" : "s"}`}
            </Button>
            <span className="text-[13px] text-fg-muted">{otherSessionsSummary(others)}</span>
          </div>
        </Box>
        <Box title="Appearance">
          <Row label="Theme">
            <Segmented label="Theme">
              <SegmentedItem pressed={theme === "dark"} onClick={() => setTheme("dark")}>
                Dark
              </SegmentedItem>
              <SegmentedItem pressed={theme === "light"} onClick={() => setTheme("light")}>
                Light
              </SegmentedItem>
            </Segmented>
          </Row>
        </Box>
        <Box title="Session">
          <Row label="Sign out of this browser.">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void signOut().then(() => window.location.assign(LOGIN_PATH));
              }}
            >
              {busy ? "Signing out…" : "Sign out"}
            </Button>
          </Row>
        </Box>
        {confirming === null ? null : (
          <Dialog open onOpenChange={(open) => !open && setConfirming(null)}>
            <DialogContent size="sm" aria-describedby={undefined}>
              <DialogHead />
              <DialogTitle>
                {confirming === "others" ? closeOtherSessionsTitle(others.length) : closeOwnSessionTitle(confirming)}
              </DialogTitle>
              <DialogSection className="border-t-0">
                <p className="m-0 text-[14px] text-fg-muted">
                  {confirming === "others"
                    ? closeOtherSessionsConfirmation(others.length)
                    : closeOwnSessionConfirmation(confirming)}
                </p>
              </DialogSection>
              <DialogFoot className="justify-end">
                <ButtonGroup>
                  <Button variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>
                    Cancel
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() => void (confirming === "others" ? closeOthers() : closeOne(confirming))}
                  >
                    {busy ? "Closing…" : confirming === "others" ? "Close other sessions" : "Close session"}
                  </Button>
                </ButtonGroup>
              </DialogFoot>
            </DialogContent>
          </Dialog>
        )}
      </section>
    </AppShell>
  );
}
