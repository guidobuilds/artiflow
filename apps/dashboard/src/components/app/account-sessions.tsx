import { useEffect, useState } from "react";

import { SessionRows } from "@/components/app/session-rows.tsx";
import { Button, ButtonGroup } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogFoot, DialogHead, DialogSection, DialogTitle } from "@/components/ui/dialog.tsx";
import {
  EMPTY_SESSION_READ,
  accountSessionClosedNotice,
  accountSessionsClosedNotice,
  adminSessionRevokeConfirmation,
  adminSessionRevokeTitle,
  adminSessionsRevokeConfirmation,
  adminSessionsRevokeTitle,
  applySessionRead,
  readAccountSessions,
  revokeAccountSession,
  revokeAccountSessions,
  type SessionListRead,
  type SessionRow,
} from "../../sessions-client.ts";

export function AccountSessionsPanel({ userId, who }: { userId: string; who: string }) {
  const [read, setRead] = useState<SessionListRead>(EMPTY_SESSION_READ);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [confirming, setConfirming] = useState<SessionRow | "all" | null>(null);

  useEffect(() => {
    let live = true;
    void readAccountSessions(userId).then((result) => {
      if (!live) return;
      setRead((current) => applySessionRead(current, result));
    });
    return () => {
      live = false;
    };
  }, [userId, revision]);

  const rows = read.sessions;
  const rowCount = rows === null ? 0 : rows.length;

  const closeOne = async () => {
    if (busy || confirming === null || confirming === "all") return;
    const row = confirming;
    setBusy(true);
    setNotice("");
    const result = await revokeAccountSession(userId, row.id);
    setBusy(false);
    setConfirming(null);
    if (!result.ok) {
      setNotice(result.error);
      setRevision((current) => current + 1);
      return;
    }
    setNotice(accountSessionClosedNotice(row));
    setRevision((current) => current + 1);
  };

  const closeAll = async () => {
    if (busy || confirming !== "all") return;
    setBusy(true);
    setNotice("");
    const result = await revokeAccountSessions(userId);
    setBusy(false);
    setConfirming(null);
    if (!result.ok) {
      setNotice(result.error);
      setRevision((current) => current + 1);
      return;
    }
    setNotice(accountSessionsClosedNotice(result.value.revoked, who));
    setRevision((current) => current + 1);
  };

  return (
    <section className="grid gap-4" aria-label={`Sessions of ${who}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-fg-muted">
          Every browser signed in as {who}. A closure ends that session now; the account and everything it owns stay as
          they are.
        </p>
        <Button
          size="sm"
          variant="danger"
          disabled={busy || rows === null || rows.length === 0}
          onClick={() => setConfirming("all")}
        >
          Close all sessions
        </Button>
      </div>
      {read.failure !== "" ? (
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
      {rows === null ? (
        <p className="text-[13px] text-fg-muted">Reading the sessions of {who}…</p>
      ) : rows.length === 0 ? (
        <p className="text-[14px] text-fg-muted">
          {who} has no open session. Nothing is signed in as that account right now.
        </p>
      ) : (
        <SessionRows
          sessions={rows}
          currentLabel="Your session"
          action={(row) => (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(row)}>
              Close
            </Button>
          )}
        />
      )}
      {confirming === null ? null : (
        <Dialog open onOpenChange={(open) => !open && setConfirming(null)}>
          <DialogContent size="sm" aria-describedby={undefined}>
            <DialogHead />
            <DialogTitle>
              {confirming === "all" ? adminSessionsRevokeTitle(who) : adminSessionRevokeTitle(who, confirming)}
            </DialogTitle>
            <DialogSection className="border-t-0">
              <p className="m-0 text-[14px] text-fg-muted">
                {confirming === "all"
                  ? adminSessionsRevokeConfirmation(who, rowCount)
                  : adminSessionRevokeConfirmation(who, confirming)}
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
                  onClick={() => void (confirming === "all" ? closeAll() : closeOne())}
                >
                  {busy ? "Closing…" : confirming === "all" ? "Close all sessions" : "Close session"}
                </Button>
              </ButtonGroup>
            </DialogFoot>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}
