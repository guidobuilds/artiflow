import { useState } from "react";

import { exampleCatalog } from "@artiflow/domain/examples";
import { labelFor } from "@artiflow/domain/kinds";
import { createExampleArtifact } from "./artifact-api.ts";
import { ownArtifactOpenHref } from "./library-access.ts";
import { Button, ButtonGroup } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFoot,
  DialogHead,
  DialogNote,
  DialogSection,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { cn } from "@/lib/utils.ts";

const CATALOG = exampleCatalog();

export default function ExampleDialog({ onClose }: { onClose: () => void }) {
  const [chosen, setChosen] = useState<string>(CATALOG[0]?.id ?? "report");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = () => {
    setBusy(true);
    setError(null);
    void createExampleArtifact(chosen).then((result) => {
      setBusy(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      window.location.assign(ownArtifactOpenHref(result.value.kind, result.value.id));
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined}>
        <DialogHead />
        <DialogTitle>Start from an example</DialogTitle>
        <DialogDescription>
          The example becomes your own artifact. You can change it, share it and delete it; nobody else's copy changes.
        </DialogDescription>
        <DialogSection role="radiogroup" aria-label="Example">
          {CATALOG.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="radio"
              aria-checked={chosen === entry.id}
              onClick={() => setChosen(entry.id)}
              className={cn(
                "grid cursor-pointer gap-1 rounded-lg border p-3.5 text-left transition-colors duration-120",
                chosen === entry.id ? "border-fg bg-surface" : "border-line hover:border-line-strong hover:bg-surface",
              )}
            >
              <span className="flex flex-wrap items-center gap-2">
                <b className="font-semibold">{entry.label}</b>
                <span className="rounded-full border border-line px-2 py-0.5 text-[12px] text-fg-muted">
                  {labelFor(entry.kind)}
                </span>
              </span>
              <span className="text-[13.5px] text-fg-muted">{entry.description}</span>
            </button>
          ))}
          <DialogNote>
            {chosen === "variants"
              ? "A Design and its two screens are created, so the variants can be compared and tried right away."
              : "One Page is created with its own viewer and link."}
          </DialogNote>
          {error ? (
            <p role="alert" className="text-[13px] text-danger-text">
              {error}
            </p>
          ) : null}
        </DialogSection>
        <DialogFoot className="justify-end">
          <ButtonGroup>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={create} disabled={busy}>
              {busy ? "Creating…" : "Create example"}
            </Button>
          </ButtonGroup>
        </DialogFoot>
      </DialogContent>
    </Dialog>
  );
}
