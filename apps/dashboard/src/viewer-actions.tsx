import { useCallback, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";

import "@/styles/globals.css";

import { renameArtifact } from "@/artifact-api.ts";
import DeleteModal from "@/DeleteModal.tsx";
import ShareModal from "@/ShareModal.tsx";
import { Button, ButtonGroup } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogFoot, DialogHead, DialogSection, DialogTitle } from "@/components/ui/dialog.tsx";
import { Field, Input } from "@/components/ui/input.tsx";
import { Menu, MenuItem } from "@/components/ui/menu.tsx";
import { ToastProvider } from "@/components/ui/toast.tsx";
import { QueryProvider } from "@/query/provider.tsx";

type Config = { readonly id: string; readonly title: string | null; readonly kind: string };
type Panel = "none" | "share" | "delete" | "rename";
export type RenameState = "ready" | "empty" | "unchanged" | "too_long";

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

export function renameState(current: string | null, next: string): RenameState {
  const value = next.trim();
  if (value.length === 0) return "empty";
  if (value.length > 200) return "too_long";
  return value === (current ?? "").trim() ? "unchanged" : "ready";
}

export function renameNotice(state: RenameState): string | null {
  if (state === "empty") return "Enter a title to save.";
  if (state === "too_long") return "Titles are limited to 200 characters.";
  return null;
}

type TitleRoot = { title: string; querySelector(selector: string): { textContent: string | null } | null };

export function applyTitle(root: TitleRoot | undefined, title: string): void {
  if (root === undefined) return;
  const node = root.querySelector(".vbar-title b");
  if (node !== null) node.textContent = title;
  root.title = title;
}

const modifierHeld = (event: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean =>
  event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;

function RenameDialog({
  id,
  title,
  onClose,
  onSaved,
}: {
  id: string;
  title: string;
  onClose: () => void;
  onSaved: (title: string) => void;
}) {
  const [value, setValue] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = renameState(title, value);
  const notice = renameNotice(state);

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (state !== "ready" || busy) return;
    setBusy(true);
    setError(null);
    void renameArtifact(id, value.trim()).then((result) => {
      setBusy(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onSaved(result.value.title);
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent size="sm" aria-describedby={undefined}>
        <DialogHead />
        <DialogTitle>Rename artifact</DialogTitle>
        <form onSubmit={save}>
          <DialogSection className="border-t-0">
            <Field label="Title" htmlFor="artifact-rename-title" error={error ?? notice ?? undefined}>
              <Input
                id="artifact-rename-title"
                value={value}
                autoFocus
                onChange={(event) => setValue(event.target.value)}
              />
            </Field>
          </DialogSection>
          <DialogFoot className="justify-end">
            <ButtonGroup>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={state !== "ready" || busy}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </ButtonGroup>
          </DialogFoot>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ViewerActions({ config }: { config: Config }) {
  const [panel, setPanel] = useState<Panel>("none");
  const [current, setCurrent] = useState(config.title);
  const trigger = useRef<HTMLButtonElement>(null);
  const title = current?.trim() || "Untitled artifact";

  const open = (next: Panel) => () => setPanel(next);

  const close = useCallback(() => {
    setPanel("none");
    refocusAfterClose(
      () => trigger.current,
      (task) => void requestAnimationFrame(task),
    );
  }, []);

  const saved = useCallback(
    (next: string) => {
      applyTitle(document, next);
      setCurrent(next);
      close();
    },
    [close],
  );

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
        <MenuItem icon="pencil" onClick={open("rename")}>
          Rename
        </MenuItem>
        <MenuItem icon="trash" danger onClick={open("delete")}>
          Delete
        </MenuItem>
      </Menu>
      {panel === "share" ? <ShareModal artifactId={config.id} title={title} onClose={close} /> : null}
      {panel === "rename" ? (
        <RenameDialog id={config.id} title={current ?? ""} onClose={close} onSaved={saved} />
      ) : null}
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
