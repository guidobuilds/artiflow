import { useState } from "react";

import type { SceneFrame } from "@artiflow/domain/scene";

import { refreshArtboardSource } from "./artboard-source.ts";

const shortRevision = (revisionId: string): string => revisionId.slice(0, 8);

export function ArtboardCard({ frame }: { frame: SceneFrame }) {
  const source = frame.source;
  if (source === undefined) return null;
  return (
    <div className="canvas-artboard" aria-label={`Live artboard ${frame.name}`}>
      <p className="canvas-artboard-badge">Live artboard</p>
      <p className="canvas-artboard-meta">
        {source.mode === "fluid" ? "Fluid" : "Fixed"} · pinned <code>{shortRevision(source.revisionId)}</code>
      </p>
      <p className="canvas-artboard-hint">Open the Design to compare it at 390 and 1280.</p>
    </div>
  );
}

export function ArtboardUpdateAction({
  designId,
  frame,
  disabled,
}: {
  designId: string;
  frame: SceneFrame;
  disabled: boolean;
}) {
  const [step, setStep] = useState<"idle" | "confirm" | "working" | "error">("idle");
  if (frame.source === undefined) return null;

  const run = async () => {
    setStep("working");
    const result = await refreshArtboardSource(designId, frame.id);
    if (result === null) {
      setStep("error");
      return;
    }
    window.location.reload();
  };

  return (
    <div className="canvas-artboard-update" role="group" aria-label={`Artboard ${frame.name}`}>
      {step === "confirm" ? (
        <>
          <button
            type="button"
            className="canvas-artboard-update-action"
            onClick={run}
            disabled={disabled}
          >
            Confirm update to latest
          </button>
          <button type="button" className="canvas-artboard-update-cancel" onClick={() => setStep("idle")}>
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          className="canvas-artboard-update-action"
          disabled={disabled || step === "working"}
          onClick={() => setStep("confirm")}
        >
          {step === "working" ? "Updating…" : "Update to latest revision"}
        </button>
      )}
      <p className="canvas-artboard-update-status" role="status">
        {step === "error" ? "The latest revision could not be read." : ""}
      </p>
    </div>
  );
}
