import { useEffect, useState } from "react";

import { passwordPolicyStatements, readPasswordPolicyInForce } from "../../password-policy-client.ts";

export type PasswordPolicyReading =
  { kind: "reading" } | { kind: "shown"; statements: string[] } | { kind: "unavailable"; message: string };

export function usePasswordPolicyReading(): PasswordPolicyReading {
  const [reading, setReading] = useState<PasswordPolicyReading>({ kind: "reading" });
  useEffect(() => {
    let live = true;
    void readPasswordPolicyInForce()
      .then((result) => {
        if (!live) return;
        setReading(
          result.ok
            ? { kind: "shown", statements: passwordPolicyStatements(result.value) }
            : { kind: "unavailable", message: result.error },
        );
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return reading;
}

export function PasswordPolicyNotice({ reading }: { reading: PasswordPolicyReading }) {
  if (reading.kind === "reading") return null;
  if (reading.kind === "unavailable") {
    return (
      <p id="password-policy" role="status" className="text-[13px] text-fg-muted">
        {reading.message}
      </p>
    );
  }
  return (
    <div id="password-policy" className="grid gap-1.5">
      <p className="text-[13px] font-medium text-fg-muted">Password policy</p>
      <ul className="grid gap-1 text-[13px] text-fg-subtle">
        {reading.statements.map((statement) => (
          <li key={statement}>{statement}</li>
        ))}
      </ul>
    </div>
  );
}
