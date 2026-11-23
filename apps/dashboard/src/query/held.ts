import { useQuery, type QueryKey } from "@tanstack/react-query";
import { useState } from "react";

import type { AdminGate } from "../admin-entry.ts";

export function nextHeld<TResult, TRead>(
  held: TRead,
  seen: TResult | undefined,
  incoming: TResult | undefined,
  apply: (current: TRead, result: TResult) => TRead,
): { held: TRead; seen: TResult | undefined } {
  if (incoming === seen) return { held, seen };
  if (incoming === undefined) return { held, seen: undefined };
  return { held: apply(held, incoming), seen: incoming };
}

export function useHeldQuery<TResult, TRead>({
  queryKey,
  queryFn,
  initial,
  apply,
}: {
  queryKey: QueryKey;
  queryFn: () => Promise<TResult>;
  initial: TRead;
  apply: (current: TRead, result: TResult) => TRead;
}): { read: TRead; setRead: (update: (current: TRead) => TRead) => void } {
  const query = useQuery({ queryKey, queryFn });
  const [held, setHeld] = useState(initial);
  const [seen, setSeen] = useState<TResult | undefined>(undefined);
  const next = nextHeld(held, seen, query.data, apply);
  if (next.seen !== seen) setSeen(next.seen);
  if (next.held !== held) setHeld(next.held);
  return { read: next.held, setRead: setHeld };
}

type ConfigResult<T> = { ok: true; value: T } | { ok: false; error: string; signInRequired: boolean };

export function useAdminConfiguration<T>(
  queryKey: QueryKey,
  queryFn: () => Promise<ConfigResult<T>>,
): {
  value: T | null;
  setValue: (value: T | null) => void;
  gate: AdminGate;
  setGate: (gate: AdminGate) => void;
} {
  const query = useQuery({ queryKey, queryFn });
  const [value, setValue] = useState<T | null>(null);
  const [gate, setGate] = useState<AdminGate>({ kind: "loading" });
  if (query.data && gate.kind === "loading") {
    if (query.data.ok) {
      setValue(query.data.value);
      setGate({ kind: "ready" });
    } else setGate({ kind: "refused", message: query.data.error, signInRequired: query.data.signInRequired });
  }
  return { value, setValue, gate, setGate };
}
