import { useQuery } from "@tanstack/react-query";

import { passwordPolicyStatements, readPasswordPolicyInForce } from "../../password-policy-client.ts";
import { queryKeys } from "../../query/keys.ts";

export type PasswordPolicyReading =
  { kind: "reading" } | { kind: "shown"; statements: string[] } | { kind: "unavailable"; message: string };

export function usePasswordPolicyReading(): PasswordPolicyReading {
  const policy = useQuery({
    queryKey: queryKeys.passwordPolicy,
    queryFn: () => readPasswordPolicyInForce(),
    staleTime: Infinity,
  });
  if (policy.data === undefined) return { kind: "reading" };
  return policy.data.ok
    ? { kind: "shown", statements: passwordPolicyStatements(policy.data.value) }
    : { kind: "unavailable", message: policy.data.error };
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
