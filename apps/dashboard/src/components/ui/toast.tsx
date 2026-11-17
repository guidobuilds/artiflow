import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils.ts";
import { Icon } from "@/components/ui/icon.tsx";

type Toast = { id: number; message: string };
type ToastContextValue = { toast: (message: string) => void };

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast must be used inside <ToastProvider>");
  return value;
}

const TOAST_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextId = useRef(0);

  const show = useCallback((message: string) => {
    if (timer.current) clearTimeout(timer.current);
    const id = (nextId.current += 1);
    setToast({ id, message });
    timer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  const value = useMemo(() => ({ toast: show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-5 z-60 flex justify-center px-4">
        {toast ? (
          <div
            key={toast.id}
            role="status"
            className={cn(
              "inline-flex max-w-[min(100%,520px)] items-center gap-2.5 rounded-md border border-line-strong bg-bg-raised py-2 pr-3.5 pl-3 shadow-floating",
              "animate-[pop-in_150ms_cubic-bezier(.2,.8,.2,1)]",
            )}
          >
            <Icon name="check" aria-hidden="true" className="size-[14px] shrink-0 text-accent-text" />
            <p className="text-[13.5px] text-fg">{toast.message}</p>
          </div>
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}
