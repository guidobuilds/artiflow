import { useEffect, useState, type ReactNode } from "react";

import { getSession, signOut, type AuthUser } from "./auth-client.ts";
import { AppShell, PageHeader } from "@/components/app/app-shell.tsx";
import { useTheme } from "@/components/app/theme-provider.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Segmented, SegmentedItem } from "@/components/ui/segmented.tsx";

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
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getSession().then((result) => {
      if (cancelled) return;
      if (result.ok) setUser(result.value);
      else setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AppShell active="account" requireSession>
      <section className="grid w-full max-w-[780px] gap-[18px] px-7 pt-[30px] pb-10 max-[760px]:px-4 max-[760px]:pt-[22px]">
        <PageHeader title="Account" lede="Your profile and how this browser shows artiflow." />
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
                void signOut().then(() => window.location.assign("/login"));
              }}
            >
              {busy ? "Signing out…" : "Sign out"}
            </Button>
          </Row>
        </Box>
      </section>
    </AppShell>
  );
}
