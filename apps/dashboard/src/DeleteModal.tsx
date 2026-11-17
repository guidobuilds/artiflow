import { useState } from "react";

import { DELETE_LABEL, deleteArtifact, pressDelete, type ArtifactSummary, type DeleteConfirm } from "./auth-client.ts";
import { Button, ButtonGroup } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogFoot, DialogHead, DialogSection, DialogTitle } from "@/components/ui/dialog.tsx";

export default function DeleteModal({
  artifact,
  onDeleted,
  onClose,
}: {
  artifact: ArtifactSummary;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const [confirm, setConfirm] = useState<DeleteConfirm>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const press = () => {
    setBusy(true);
    setError(null);
    void pressDelete(confirm, () => deleteArtifact(artifact.id)).then((step) => {
      setBusy(false);
      setConfirm(step.state);
      if (step.result === null) return;
      if (!step.result.ok) {
        setError(step.result.error);
        return;
      }
      onDeleted();
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm" aria-describedby={undefined}>
        <DialogHead />
        <DialogTitle>Delete “{artifact.title}”?</DialogTitle>
        <DialogSection className="border-t-0">
          <p className="m-0 text-[14px] text-fg-muted">
            Deleting <span className="text-fg">{artifact.title}</span> ({artifact.sizeLabel}, {artifact.versionsLabel})
            blocks the viewer and every share and public link at once. Anyone with the old link loses access. Copies
            already opened elsewhere are not recalled.
          </p>
          {confirm === "armed" ? (
            <p role="alert" className="text-[13px] text-danger-text">
              Press {DELETE_LABEL.armed} to delete for good. This cannot be undone.
            </p>
          ) : null}
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
            <Button variant="danger" onClick={press} disabled={busy}>
              {busy ? "Deleting…" : DELETE_LABEL[confirm]}
            </Button>
          </ButtonGroup>
        </DialogFoot>
      </DialogContent>
    </Dialog>
  );
}
