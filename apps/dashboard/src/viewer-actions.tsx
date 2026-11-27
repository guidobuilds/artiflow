import { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import "@/styles/globals.css";

import DeleteModal from "@/DeleteModal.tsx";
import ShareModal from "@/ShareModal.tsx";
import { Menu, MenuItem } from "@/components/ui/menu.tsx";
import { ToastProvider } from "@/components/ui/toast.tsx";
import { QueryProvider } from "@/query/provider.tsx";

type Config = { readonly id: string; readonly title: string | null; readonly kind: string };
type Panel = "none" | "share" | "delete";

export function triggerIntent(key: string, modified: boolean): "open" | "ignore" {
  return !modified && key === "ArrowDown" ? "open" : "ignore";
}

export function refocusAfterClose(trigger: () => HTMLElement | null, schedule: (task: () => void) => void): void {
  schedule(() => {
    const node = trigger();
    if (node === null || node.isConnected === false) return;
    node.focus({ preventScroll: true });
  });
}

const modifierHeld = (event: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean =>
  event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;

function ViewerActions({ config }: { config: Config }) {
  const [panel, setPanel] = useState<Panel>("none");
  const trigger = useRef<HTMLButtonElement>(null);
  const title = config.title?.trim() || "Untitled artifact";

  const open = (next: Panel) => () => setPanel(next);

  const close = useCallback(() => {
    setPanel("none");
    refocusAfterClose(
      () => trigger.current,
      (task) => void requestAnimationFrame(task),
    );
  }, []);

  const removed = useCallback(() => window.location.assign("/"), []);

  return (
    <>
      <Menu
        trigger={
          <button
            ref={trigger}
            type="button"
            data-control="menu"
            onKeyDown={(event) => {
              if (triggerIntent(event.key, modifierHeld(event)) !== "open") return;
              event.preventDefault();
              event.currentTarget.click();
            }}
          >
            Actions
          </button>
        }
      >
        <MenuItem icon="link" onClick={open("share")}>
          Share
        </MenuItem>
        <MenuItem icon="trash" danger onClick={open("delete")}>
          Delete
        </MenuItem>
      </Menu>
      {panel === "share" ? <ShareModal artifactId={config.id} title={title} onClose={close} /> : null}
      {panel === "delete" ? (
        <DeleteModal artifact={{ id: config.id, title, kind: config.kind }} onDeleted={removed} onClose={close} />
      ) : null}
    </>
  );
}

const readConfig = (): Config | null => {
  const node = document.getElementById("viewer-management-data");
  if (node === null) return null;
  try {
    const parsed = JSON.parse(node.textContent ?? "") as Partial<Config>;
    if (typeof parsed.id !== "string" || parsed.id === "" || typeof parsed.kind !== "string") return null;
    return { id: parsed.id, kind: parsed.kind, title: typeof parsed.title === "string" ? parsed.title : null };
  } catch {
    return null;
  }
};

const mount = (): void => {
  const host = document.querySelector<HTMLElement>('[data-island="actions"]');
  const config = readConfig();
  if (host === null || config === null) return;
  createRoot(host).render(
    <QueryProvider>
      <ToastProvider>
        <ViewerActions config={config} />
      </ToastProvider>
    </QueryProvider>,
  );
};

if (typeof document !== "undefined") mount();
